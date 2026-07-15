import type { SpanKind } from "@opentelemetry/api"

/** Selects the telemetry schema emitted by the plugin. */
export type TelemetryProfileName = "opencode" | "claude-code"

/** Resolves metric, event, span, and instrumentation names for a telemetry schema. */
export type TelemetryProfile = {
  name: TelemetryProfileName
  metricPrefix: string
  scopeName: string
  schemaAttrs: Readonly<Record<string, string>>
  eventBody(eventName: string): string | undefined
  metricUnit(metricName: string, defaultUnit: string): string
  spanName(spanType: "interaction" | "llm_request" | "tool", toolName?: string): string
  spanType(spanType: "interaction" | "llm_request" | "tool"): string
  spanKind(spanType: "interaction" | "llm_request" | "tool"): SpanKind | undefined
}

const CLAUDE_EVENTS = new Set([
  "user_prompt",
  "api_request",
  "api_error",
  "tool_result",
  "tool_decision",
])

/** Creates the immutable naming contract for the selected telemetry schema. */
export function createTelemetryProfile(name: TelemetryProfileName, metricPrefix: string): TelemetryProfile {
  if (name === "claude-code") {
    return {
      name,
      metricPrefix: "claude_code.",
      scopeName: "com.opencode.claude_code_compat",
      schemaAttrs: {
        "telemetry.schema.name": "claude-code",
        "telemetry.schema.baseline": "2026-07-14",
      },
      eventBody: eventName => CLAUDE_EVENTS.has(eventName) ? `claude_code.${eventName}` : undefined,
      metricUnit: metricName => new Set(["session.count", "lines_of_code.count", "commit.count"]).has(metricName) ? "count" : ({ "token.usage": "tokens", "cost.usage": "USD" }[metricName] ?? "1"),
      spanName: spanType => `claude_code.${spanType === "llm_request" ? "llm_request" : spanType}`,
      spanType: spanType => spanType,
      spanKind: () => undefined,
    }
  }

  return {
    name,
    metricPrefix,
    scopeName: "com.opencode",
    schemaAttrs: {},
    eventBody: eventName => eventName,
    metricUnit: (_metricName, defaultUnit) => defaultUnit,
    spanName: (spanType, toolName) => {
      if (spanType === "interaction") return `${metricPrefix}session`
      if (spanType === "llm_request") return `${metricPrefix}llm`
      return `${metricPrefix}tool.${toolName ?? "unknown"}`
    },
    spanType: spanType => spanType,
    spanKind: () => undefined,
  }
}

/** Lists metrics defined by the Claude Code compatibility schema. */
export const CLAUDE_STANDARD_METRICS = new Set([
  "session.count",
  "token.usage",
  "cost.usage",
  "lines_of_code.count",
  "commit.count",
])
