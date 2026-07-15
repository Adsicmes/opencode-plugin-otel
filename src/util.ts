import { trace, type Context } from "@opentelemetry/api"
import type { LogAttributes, LogRecord, SeverityNumber } from "@opentelemetry/api-logs"
import { MAX_PENDING } from "./types.ts"
import { CLAUDE_STANDARD_METRICS } from "./schema.ts"
import type { HandlerContext, SessionAgentType } from "./types.ts"

/** Returns a human-readable summary string from an opencode error object. */
export function errorSummary(err: { name: string; data?: unknown; messageLength?: number } | undefined): string {
  if (!err) return "unknown"
  const name = err.name.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "unknown"
  if (err.messageLength !== undefined) return `${name} (message_length=${err.messageLength})`
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    const message = (err.data as { message: unknown }).message
    if (typeof message === "string") return `${name} (message_length=${message.length})`
  }
  return name
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= MAX_PENDING) {
    const [firstKey] = map.keys()
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

/** Resolves a root-run context from the live span first, then from the retained ended span context. */
export function resolveRunTraceContext(runID: string, ctx: Pick<HandlerContext, "rootContext" | "runSpans" | "runSpanContexts">) {
  const baseCtx = ctx.rootContext()
  const runSpan = ctx.runSpans.get(runID)
  if (runSpan) return trace.setSpan(baseCtx, runSpan)
  const runSpanContext = ctx.runSpanContexts.get(runID)
  return runSpanContext ? trace.setSpanContext(baseCtx, runSpanContext) : baseCtx
}

/** Resolves the best available trace parent for a session event or message/tool child span. */
export function resolveSessionTraceContext(
  sessionID: string,
  ctx: HandlerContext,
  input?: { assistantMessageID?: string; runID?: string },
) {
  const baseCtx = ctx.rootContext()
  const sessionSpan = ctx.sessionSpans.get(sessionID)
  if (sessionSpan) return trace.setSpan(baseCtx, sessionSpan)
  const sessionSpanContext = ctx.sessionSpanContexts.get(sessionID)
  if (sessionSpanContext) return trace.setSpanContext(baseCtx, sessionSpanContext)
  if (input?.runID) return resolveRunTraceContext(input.runID, ctx)
  const assistantRunID = input?.assistantMessageID
    ? ctx.assistantRuns.get(input.assistantMessageID)
    : undefined
  if (assistantRunID) return resolveRunTraceContext(assistantRunID, ctx)
  const activeRunID = ctx.activeRuns.get(sessionID)
  return activeRunID ? resolveRunTraceContext(activeRunID, ctx) : baseCtx
}

/**
 * Returns `true` if the metric name (without prefix) is not in the disabled set.
 * The `name` should be the suffix after the metric prefix, e.g. `"session.count"`.
 */
export function isMetricEnabled(name: string, ctx: { disabledMetrics: Set<string>; profile?: HandlerContext["profile"] }): boolean {
  if (ctx.profile?.name === "claude-code" && !CLAUDE_STANDARD_METRICS.has(name)) return false
  return !ctx.disabledMetrics.has(name)
}

export function emitTelemetryEvent(
  ctx: HandlerContext,
  input: {
    eventName: string
    sessionID: string
    timestamp: number
    severityNumber: SeverityNumber
    severityText: string
    attributes?: LogAttributes
    context?: Context
    runID?: string
    promptID?: string
  },
) {
  const body = ctx.profile.eventBody(input.eventName)
  if (!body) return
  const prompt = input.promptID
    ? { promptID: input.promptID }
    : input.runID
      ? ctx.promptContextsByRun.get(input.runID)
      : ctx.promptContexts.get(input.sessionID)
  const sequence = nextEventSequence(input.sessionID, ctx)
  const profileAttrs = ctx.profile.name === "claude-code"
    ? {
        "event.timestamp": new Date(input.timestamp).toISOString(),
        ...(sequence === undefined ? {} : { "event.sequence": sequence }),
        ...(prompt ? { "prompt.id": prompt.promptID } : {}),
      }
    : {}
  const record: LogRecord = {
    severityNumber: input.severityNumber,
    severityText: input.severityText,
    timestamp: input.timestamp,
    observedTimestamp: Date.now(),
    body,
    attributes: {
      "event.name": input.eventName,
      "session.id": input.sessionID,
      ...profileAttrs,
      ...input.attributes,
      ...ctx.commonAttrs,
    },
    ...(input.context ? { context: input.context } : {}),
  }
  ctx.emitLog(record)
}

export function beginPrompt(sessionID: string, runID: string | undefined, ctx: HandlerContext): string {
  const promptID = crypto.randomUUID()
  const interactionSequence = (ctx.interactionSequences.get(sessionID) ?? 0) + 1
  setBoundedMap(ctx.interactionSequences, sessionID, interactionSequence)
  const prompt = { sessionID, promptID, interactionSequence, ...(runID ? { runID } : {}) }
  setBoundedMap(ctx.promptContexts, sessionID, prompt)
  if (runID) setBoundedMap(ctx.promptContextsByRun, runID, prompt)
  return promptID
}

export function nextEventSequence(sessionID: string, ctx: HandlerContext): number | undefined {
  if (!ctx.promptContexts.has(sessionID)) return undefined
  const sequence = ctx.eventSequences.get(sessionID) ?? 0
  setBoundedMap(ctx.eventSequences, sessionID, sequence + 1)
  return sequence
}

/**
 * Returns `true` if the trace type is not in the disabled set.
 * Valid names are `"session"`, `"llm"`, and `"tool"`.
 */
export function isTraceEnabled(name: string, ctx: { disabledTraces: Set<string> }): boolean {
  return !ctx.disabledTraces.has(name)
}

/**
 * Accumulates token and cost totals for a session, and increments the message count.
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place.
 * No-ops silently if the session was not previously registered via `handleSessionCreated`.
 */
export function accumulateSessionTotals(
  sessionID: string,
  tokens: number,
  cost: number,
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID)
  if (!existing) return
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens + tokens,
    cost: existing.cost + cost,
    messages: existing.messages + 1,
    agent: existing.agent,
    agentType: existing.agentType,
  })
}

/** Returns the current session-scoped agent name/type, defaulting to `unknown` when unavailable. */
export function getSessionAgentMeta(
  sessionID: string,
  ctx: Pick<HandlerContext, "sessionTotals">,
): { agentName: string; agentType: SessionAgentType | "unknown" } {
  const totals = ctx.sessionTotals.get(sessionID)
  return {
    agentName: totals?.agent ?? "unknown",
    agentType: totals?.agentType ?? "unknown",
  }
}

/** Builds a consistent agent attribute set for OTLP logs, metrics, and spans. */
export function agentAttrs(agentName: string, agentType: SessionAgentType | "unknown") {
  return {
    agent: agentName,
    "agent.name": agentName,
    "agent.type": agentType,
  } as const
}
