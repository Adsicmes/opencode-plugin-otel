import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode, SpanKind, trace, type Context } from "@opentelemetry/api"
import type { AssistantMessage, EventMessageUpdated, EventMessagePartUpdated, ToolPart } from "@opencode-ai/sdk"
import {
  AGENT_NAME,
  LLM_COST_TOTAL,
  LLM_MODEL_NAME,
  LLM_PROVIDER,
  LLM_SYSTEM,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
  LLM_TOKEN_COUNT_TOTAL,
  OpenInferenceSpanKind,
  SemanticConventions,
  SESSION_ID,
  TOOL_ID,
  TOOL_NAME,
} from "@arizeai/openinference-semantic-conventions"
import {
  agentAttrs,
  errorSummary,
  setBoundedMap,
  accumulateSessionTotals,
  getSessionAgentMeta,
  isMetricEnabled,
  isTraceEnabled,
  resolveSessionTraceContext,
  emitTelemetryEvent,
} from "../util.ts"
import type { HandlerContext } from "../types.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const LLM_FINISH_REASON = "llm.finish_reason"
type SubtaskPart = {
  type: "subtask"
  sessionID: string
  messageID: string
  prompt: string
  description: string
  agent: string
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
}

/**
 * Handles a completed assistant message: increments token and cost counters, emits
 * either an `api_request` or `api_error` log event, and ends the LLM span for this message.
 * The `agent` attribute is sourced from the session totals, which are populated by the
 * `chat.message` hook when the user prompt is received.
 */
export function handleMessageUpdated(e: EventMessageUpdated, ctx: HandlerContext) {
  const msg = e.properties.info
  if (msg.role !== "assistant") return
  const assistant = msg as AssistantMessage
  setBoundedMap(ctx.assistantRuns, assistant.id, assistant.parentID)
  if (!assistant.time.completed) return

  const { sessionID, modelID, providerID } = assistant
  const duration = assistant.time.completed - assistant.time.created
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  const agent = agentName
  const querySource = agentType === "subagent" ? "subagent" : "main"

  const totalTokens = assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning
    + assistant.tokens.cache.read + assistant.tokens.cache.write

  if (isMetricEnabled("token.usage", ctx)) {
    const { tokenCounter } = ctx.instruments
    const metricAttrs = ctx.profile.name === "claude-code"
      ? { "agent.name": agent, query_source: querySource }
      : { agent }
    tokenCounter.add(assistant.tokens.input, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, ...metricAttrs, type: "input" })
    tokenCounter.add(assistant.tokens.output, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, ...metricAttrs, type: "output" })
    if (ctx.profile.name !== "claude-code") {
      tokenCounter.add(assistant.tokens.reasoning, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "reasoning" })
    }
    tokenCounter.add(assistant.tokens.cache.read, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, ...metricAttrs, type: "cacheRead" })
    tokenCounter.add(assistant.tokens.cache.write, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, ...metricAttrs, type: "cacheCreation" })
  }

  if (isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(assistant.cost, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
      model: modelID,
      ...(ctx.profile.name === "claude-code"
        ? { "agent.name": agent, query_source: querySource }
        : { agent }),
    })
  }

  if (isMetricEnabled("cache.count", ctx)) {
    if (assistant.tokens.cache.read > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "cacheRead" })
    }
    if (assistant.tokens.cache.write > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "cacheCreation" })
    }
  }

  if (isMetricEnabled("message.count", ctx)) {
    ctx.instruments.messageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent })
  }

  if (isMetricEnabled("model.usage", ctx)) {
    ctx.instruments.modelUsageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, provider: providerID, agent })
  }

  accumulateSessionTotals(sessionID, totalTokens, assistant.cost, ctx)

  ctx.log("debug", "otel: token+cost counters incremented", {
    sessionID,
    model: modelID,
    agent,
    input: assistant.tokens.input,
    output: assistant.tokens.output,
    reasoning: assistant.tokens.reasoning,
    cacheRead: assistant.tokens.cache.read,
    cacheWrite: assistant.tokens.cache.write,
    cost_usd: assistant.cost,
  })

  const msgKey = `${sessionID}:${assistant.id}`
  const msgSpan = ctx.messageSpans.get(msgKey)
  let logContext: Context | undefined
  if (msgSpan) {
    const outputLength = ctx.messageOutputLengths.get(msgKey)
    msgSpan.setAttributes({
      [AGENT_NAME]: agentName,
      "agent.type": agentType,
      [LLM_TOKEN_COUNT_PROMPT]: assistant.tokens.input,
      [LLM_TOKEN_COUNT_COMPLETION]: assistant.tokens.output,
      [LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: assistant.tokens.reasoning,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: assistant.tokens.cache.read,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: assistant.tokens.cache.write,
      [LLM_TOKEN_COUNT_TOTAL]: totalTokens,
      [LLM_FINISH_REASON]: assistant.error ? "error" : (assistant.finish ?? "stop"),
      [LLM_COST_TOTAL]: assistant.cost,
      ...(outputLength ? { "output.length": outputLength } : {}),
      cost_usd: assistant.cost,
      duration_ms: duration,
      ...(ctx.profile.name === "claude-code"
        ? {
            "span.type": ctx.profile.spanType("llm_request"),
            model: modelID,
            "gen_ai.system": providerID,
            "gen_ai.request.model": modelID,
            input_tokens: assistant.tokens.input,
            output_tokens: assistant.tokens.output,
            cache_read_tokens: assistant.tokens.cache.read,
            cache_creation_tokens: assistant.tokens.cache.write,
            query_source: querySource,
            success: !assistant.error,
          }
        : {}),
    })
    const spanContext = msgSpan.spanContext()
    logContext = trace.setSpanContext(ctx.rootContext(), spanContext)
    if (assistant.error) {
      msgSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(assistant.error) })
    } else {
      msgSpan.setStatus({ code: SpanStatusCode.OK })
    }
    msgSpan.end(assistant.time.completed)
    ctx.messageSpans.delete(msgKey)
    ctx.messageOutputLengths.delete(msgKey)
  }

  if (assistant.error) {
    emitTelemetryEvent(ctx, {
      eventName: "api_error",
      sessionID,
      timestamp: ctx.profile.name === "claude-code" ? assistant.time.completed : assistant.time.created,
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      context: logContext,
      runID: assistant.parentID,
      attributes: {
        model: modelID,
        provider: providerID,
        ...agentAttrs(agentName, agentType),
        ...(ctx.profile.name === "claude-code" ? { query_source: querySource } : {}),
        error: errorSummary(assistant.error),
        duration_ms: duration,
      },
    })
    return ctx.log("error", "otel: api_error", {
      sessionID,
      model: modelID,
      agent,
      error: errorSummary(assistant.error),
      duration_ms: duration,
    })
  }

  emitTelemetryEvent(ctx, {
    eventName: "api_request",
    sessionID,
    timestamp: ctx.profile.name === "claude-code" ? assistant.time.completed : assistant.time.created,
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    context: logContext,
    runID: assistant.parentID,
    attributes: {
        model: modelID,
        provider: providerID,
        ...agentAttrs(agentName, agentType),
        ...(ctx.profile.name === "claude-code" ? { query_source: querySource } : {}),
        cost_usd: assistant.cost,
        duration_ms: duration,
      input_tokens: assistant.tokens.input,
      output_tokens: assistant.tokens.output,
      reasoning_tokens: assistant.tokens.reasoning,
      cache_read_tokens: assistant.tokens.cache.read,
      cache_creation_tokens: assistant.tokens.cache.write,
    },
  })
  return ctx.log("info", "otel: api_request", {
    sessionID,
    model: modelID,
    agent,
    cost_usd: assistant.cost,
    duration_ms: duration,
    input_tokens: assistant.tokens.input,
    output_tokens: assistant.tokens.output,
  })
}

/**
 * Tracks tool execution time between `running` and `completed`/`error` part updates,
 * records a `tool.duration` histogram measurement, manages the tool child span, and emits
 * a `tool_result` log event. Also handles `subtask` parts, incrementing the sub-agent
 * invocation counter and emitting a `subtask_invoked` log event.
 *
 * For tool spans: on `running` a child span of the current session span is started and stored
 * in `pendingToolSpans`. On `completed`/`error` the span is ended with appropriate status.
 * If no `running` event was seen (out-of-order), a best-effort span is started and immediately ended.
 */
export function handleMessagePartUpdated(e: EventMessagePartUpdated, ctx: HandlerContext) {
  const part = e.properties.part

  if (part.type === "text") {
    const key = `${part.sessionID}:${part.messageID}`
    if (ctx.messageSpans.has(key)) {
      setBoundedMap(ctx.messageOutputLengths, key, (ctx.messageOutputLengths.get(key) ?? 0) + part.text.length)
    }
    return
  }

  if (part.type === "subtask") {
    const subtask = part as unknown as SubtaskPart
    if (isMetricEnabled("subtask.count", ctx)) {
      ctx.instruments.subtaskCounter.add(1, {
        ...ctx.commonAttrs,
        "session.id": subtask.sessionID,
        agent: subtask.agent,
        "agent.type": "subagent",
      })
    }
    emitTelemetryEvent(ctx, {
      eventName: "subtask_invoked",
      sessionID: subtask.sessionID,
      timestamp: Date.now(),
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      runID: subtask.messageID,
      attributes: {
        ...agentAttrs(subtask.agent, "subagent"),
        description_length: subtask.description.length,
        prompt_length: subtask.prompt.length,
      },
    })
    return ctx.log("info", "otel: subtask_invoked", {
      sessionID: subtask.sessionID,
      agent: subtask.agent,
      description_length: subtask.description.length,
    })
  }

  if (part.type === "tool") {
    const toolPart = part as ToolPart
    const key = `${toolPart.sessionID}:${toolPart.callID}`

    if (toolPart.state.status === "running") {
      const { agentName, agentType } = getSessionAgentMeta(toolPart.sessionID, ctx)
      const toolSpan = isTraceEnabled("tool", ctx)
        ? (() => {
            return ctx.tracer.startSpan(
              ctx.profile.spanName("tool", toolPart.tool),
              {
                startTime: toolPart.state.time.start,
                kind: SpanKind.INTERNAL,
                attributes: {
                  [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
                  [SESSION_ID]: toolPart.sessionID,
                  [TOOL_ID]: toolPart.callID,
                  [TOOL_NAME]: toolPart.tool,
                  ...(ctx.profile.name === "claude-code"
                    ? {
                        "span.type": ctx.profile.spanType("tool"),
                        tool_name: toolPart.tool,
                        tool_use_id: toolPart.callID,
                      }
                    : {}),
                  "tool.input_size_bytes": serializedByteLength(toolPart.state.input),
                  [AGENT_NAME]: agentName,
                  "agent.type": agentType,
                  ...ctx.commonAttrs,
                },
              },
              resolveSessionTraceContext(toolPart.sessionID, ctx, {
                assistantMessageID: toolPart.messageID,
              }),
            )
          })()
        : undefined
      setBoundedMap(ctx.pendingToolSpans, key, {
        tool: toolPart.tool,
        sessionID: toolPart.sessionID,
        startMs: toolPart.state.time.start,
        span: toolSpan,
        spanContext: toolSpan?.spanContext(),
      })
      ctx.log("debug", "otel: tool span started", { sessionID: toolPart.sessionID, tool: toolPart.tool, key })
      return
    }

    if (toolPart.state.status !== "completed" && toolPart.state.status !== "error") return

    const pending = ctx.pendingToolSpans.get(key)
    ctx.pendingToolSpans.delete(key)
    const start = pending?.startMs ?? toolPart.state.time.start
    const end = toolPart.state.time.end
    if (end === undefined) return
    const duration_ms = end - start
    const success = toolPart.state.status === "completed"
    const { agentName, agentType } = getSessionAgentMeta(toolPart.sessionID, ctx)

    if (isMetricEnabled("tool.duration", ctx)) {
      ctx.instruments.toolDurationHistogram.record(duration_ms, {
        ...ctx.commonAttrs,
        "session.id": toolPart.sessionID,
        tool_name: toolPart.tool,
        success,
      })
    }

    let completedSpanContext = pending?.spanContext
    if (isTraceEnabled("tool", ctx)) {
      const toolSpan = pending?.span ?? (() => {
        return ctx.tracer.startSpan(
          ctx.profile.spanName("tool", toolPart.tool),
          {
            startTime: start,
            kind: SpanKind.INTERNAL,
            attributes: {
              [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
              [SESSION_ID]: toolPart.sessionID,
              [TOOL_ID]: toolPart.callID,
              [TOOL_NAME]: toolPart.tool,
              ...(ctx.profile.name === "claude-code"
                ? {
                    "span.type": ctx.profile.spanType("tool"),
                    tool_name: toolPart.tool,
                    tool_use_id: toolPart.callID,
                  }
                : {}),
              "tool.input_size_bytes": serializedByteLength(toolPart.state.input),
              ...ctx.commonAttrs,
            },
          },
          resolveSessionTraceContext(toolPart.sessionID, ctx, {
            assistantMessageID: toolPart.messageID,
          }),
        )
      })()
      completedSpanContext = toolSpan.spanContext()
      toolSpan.setAttributes({ [AGENT_NAME]: agentName, "agent.type": agentType })
      toolSpan.setAttribute("tool.success", success)
      if (ctx.profile.name === "claude-code") toolSpan.setAttribute("duration_ms", duration_ms)
      if (success) {
        const output = (toolPart.state as { output: string }).output
        toolSpan.setAttribute("tool.result_size_bytes", Buffer.byteLength(output, "utf8"))
        toolSpan.setStatus({ code: SpanStatusCode.OK })
      } else {
        const err = (toolPart.state as { error: string }).error
        const error = errorSummary({ name: "ToolError", data: { message: err } })
        toolSpan.setAttribute("tool.error", error)
        toolSpan.setAttribute("tool.error_size_bytes", Buffer.byteLength(err, "utf8"))
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: error })
      }
      toolSpan.end(end)
    }

    const sizeAttr = success
      ? { tool_result_size_bytes: Buffer.byteLength((toolPart.state as { output: string }).output, "utf8") }
      : {
          error: errorSummary({ name: "ToolError", data: { message: (toolPart.state as { error: string }).error } }),
          error_size_bytes: Buffer.byteLength((toolPart.state as { error: string }).error, "utf8"),
        }

    const toolContext = completedSpanContext
      ? trace.setSpanContext(ctx.rootContext(), completedSpanContext)
      : undefined
    emitTelemetryEvent(ctx, {
      eventName: "tool_result",
      sessionID: toolPart.sessionID,
      timestamp: end,
      severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
      severityText: success ? "INFO" : "ERROR",
      context: toolContext,
      runID: ctx.assistantRuns.get(toolPart.messageID),
      attributes: {
        tool_name: toolPart.tool,
        ...(ctx.profile.name === "claude-code" ? { tool_use_id: toolPart.callID } : {}),
        ...(ctx.profile.name === "claude-code" ? { tool_input_size_bytes: serializedByteLength(toolPart.state.input) } : {}),
        ...agentAttrs(agentName, agentType),
        success,
        duration_ms,
        ...sizeAttr,
      },
    })
    ctx.log("debug", "otel: tool.duration histogram recorded", {
      sessionID: toolPart.sessionID,
      tool_name: toolPart.tool,
      duration_ms,
      success,
    })
    return ctx.log(success ? "info" : "error", "otel: tool_result", {
      sessionID: toolPart.sessionID,
      tool_name: toolPart.tool,
      success,
      duration_ms,
    })
  }
}

/**
 * Starts an LLM span for an assistant message when it first appears in `message.updated`.
 * The span is parented to the active run or subagent span and carries `gen_ai.*` semantic
 * attributes for the model and provider. It is ended in `handleMessageUpdated` once the
 * message completes.
 *
 * Only called for assistant messages that have not yet completed (`time.completed` absent).
 */
export function startMessageSpan(
  sessionID: string,
  messageID: string,
  parentID: string,
  modelID: string,
  providerID: string,
  startTime: number,
  ctx: HandlerContext,
) {
  setBoundedMap(ctx.assistantRuns, messageID, parentID)
  if (!isTraceEnabled("llm", ctx)) return
  const msgKey = `${sessionID}:${messageID}`
  if (ctx.messageSpans.has(msgKey)) return
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  const inputLength = ctx.runInputLengths.get(parentID)

  const msgSpan = ctx.tracer.startSpan(
    ctx.profile.spanName("llm_request"),
    {
      startTime,
      kind: SpanKind.CLIENT,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
        [SESSION_ID]: sessionID,
        [AGENT_NAME]: agentName,
        "agent.type": agentType,
        [LLM_SYSTEM]: providerID,
        [LLM_PROVIDER]: providerID,
        [LLM_MODEL_NAME]: modelID,
        ...(ctx.profile.name === "claude-code"
          ? {
              "span.type": ctx.profile.spanType("llm_request"),
              model: modelID,
              "gen_ai.system": providerID,
              "gen_ai.request.model": modelID,
              "llm_request.context": "interaction",
            }
          : {}),
        ...(inputLength ? { "input.length": inputLength } : {}),
        ...ctx.commonAttrs,
      },
    },
    resolveSessionTraceContext(sessionID, ctx, { runID: parentID, assistantMessageID: messageID }),
  )
  setBoundedMap(ctx.messageSpans, msgKey, msgSpan)
}
