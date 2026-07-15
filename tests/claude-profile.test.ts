import { describe, expect, test } from "bun:test"
import type { AssistantMessage, EventMessagePartUpdated, EventMessageUpdated, EventPermissionReplied, EventSessionIdle } from "@opencode-ai/sdk"
import { trace, type Span } from "@opentelemetry/api"
import { handleMessagePartUpdated, handleMessageUpdated, startMessageSpan } from "../src/handlers/message.ts"
import { handlePermissionReplied } from "../src/handlers/permission.ts"
import { handleSessionIdle } from "../src/handlers/session.ts"
import { beginPrompt, emitTelemetryEvent } from "../src/util.ts"
import { makeCtx } from "./helpers.ts"
import { SeverityNumber } from "@opentelemetry/api-logs"

function assistantEvent(error?: AssistantMessage["error"]): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "assistant_1",
        sessionID: "session_1",
        parentID: "user_1",
        role: "assistant",
        modelID: "model-1",
        providerID: "anthropic",
        mode: "build",
        path: { cwd: ".", root: "." },
        cost: 0.25,
        tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 4, write: 2 } },
        time: { created: 1000, completed: 2000 },
        ...(error ? { error } : {}),
      } as AssistantMessage,
    },
  }
}

function toolEvent(status: "running" | "completed"): EventMessagePartUpdated {
  const state = status === "running"
    ? { status, input: { command: "secret command" }, time: { start: 1000 } }
    : { status, input: { command: "secret command" }, output: "secret output", title: "bash", metadata: {}, time: { start: 1000, end: 1500 } }
  return {
    type: "message.part.updated",
    properties: {
      part: { type: "tool", id: "part_1", sessionID: "session_1", messageID: "assistant_1", callID: "call_1", tool: "bash", state },
    },
  } as EventMessagePartUpdated
}

describe("Claude Code telemetry profile", () => {
  test("adds event correlation fields and trace context", () => {
    const { ctx, logger, tracer } = makeCtx("project", [], [], true, {}, "claude-code")
    const span = tracer.startSpan("claude_code.interaction")
    beginPrompt("session_1", "user_1", ctx)
    emitTelemetryEvent(ctx, {
      eventName: "user_prompt",
      sessionID: "session_1",
      timestamp: 1000,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      context: trace.setSpan(ctx.rootContext(), span as unknown as Span),
      attributes: { prompt_length: 6 },
    })
    emitTelemetryEvent(ctx, {
      eventName: "api_request",
      sessionID: "session_1",
      timestamp: 2000,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
    })

    expect(logger.records.map(record => record.body)).toEqual(["claude_code.user_prompt", "claude_code.api_request"])
    expect(logger.records[0]!.attributes!["event.sequence"]).toBe(0)
    expect(logger.records[1]!.attributes!["event.sequence"]).toBe(1)
    expect(logger.records[0]!.attributes!["prompt.id"]).toBe(logger.records[1]!.attributes!["prompt.id"])
    expect(logger.records[0]!.attributes!["event.timestamp"]).toBe("1970-01-01T00:00:01.000Z")
    expect(trace.getSpanContext(logger.records[0]!.context!)).toEqual(span.spanContext())

    beginPrompt("session_1", "user_2", ctx)
    emitTelemetryEvent(ctx, {
      eventName: "user_prompt",
      sessionID: "session_1",
      timestamp: 3000,
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
    })
    expect(logger.records[2]!.attributes!["event.sequence"]).toBe(2)
    expect(logger.records[2]!.attributes!["prompt.id"]).not.toBe(logger.records[1]!.attributes!["prompt.id"])
  })

  test("keeps event sequence monotonic across idle", () => {
    const { ctx, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    beginPrompt("session_1", "user_1", ctx)
    emitTelemetryEvent(ctx, { eventName: "user_prompt", sessionID: "session_1", timestamp: 1000, severityNumber: SeverityNumber.INFO, severityText: "INFO" })
    handleSessionIdle({ type: "session.idle", properties: { sessionID: "session_1" } } as EventSessionIdle, ctx)
    beginPrompt("session_1", "user_2", ctx)
    emitTelemetryEvent(ctx, { eventName: "user_prompt", sessionID: "session_1", timestamp: 2000, severityNumber: SeverityNumber.INFO, severityText: "INFO" })
    expect(logger.records[1]!.attributes!["event.sequence"]).toBe(1)
    expect(ctx.interactionSequences.get("session_1")).toBe(2)
  })

  test("uses the event run id to correlate interleaved prompts", () => {
    const { ctx, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    const firstPromptID = beginPrompt("session_1", "user_1", ctx)
    const secondPromptID = beginPrompt("session_1", "user_2", ctx)
    emitTelemetryEvent(ctx, { eventName: "api_request", sessionID: "session_1", runID: "user_1", timestamp: 1000, severityNumber: SeverityNumber.INFO, severityText: "INFO" })
    emitTelemetryEvent(ctx, { eventName: "api_request", sessionID: "session_1", runID: "user_2", timestamp: 2000, severityNumber: SeverityNumber.INFO, severityText: "INFO" })
    expect(logger.records[0]!.attributes!["prompt.id"]).toBe(firstPromptID)
    expect(logger.records[1]!.attributes!["prompt.id"]).toBe(secondPromptID)
  })

  test("emits only the four Claude token types", () => {
    const { ctx, counters } = makeCtx("project", [], [], true, {}, "claude-code")
    ctx.sessionTotals.set("session_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build", agentType: "primary" })
    handleMessageUpdated(assistantEvent(), ctx)
    expect(counters.token.calls.map(call => call.attrs.type)).toEqual(["input", "output", "cacheRead", "cacheCreation"])
    expect(counters.token.calls.every(call => call.attrs.query_source === "main")).toBe(true)
  })

  test("uses fixed span names and redacts tool content", () => {
    const { ctx, tracer, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    startMessageSpan("session_1", "assistant_1", "user_1", "model-1", "anthropic", 1000, ctx)
    handleMessagePartUpdated(toolEvent("running"), ctx)
    handleMessagePartUpdated(toolEvent("completed"), ctx)

    expect(tracer.spans.map(span => span.name)).toEqual(["claude_code.llm_request", "claude_code.tool"])
    const toolSpan = tracer.spans[1]!
    expect(toolSpan.attributes["span.type"]).toBe("tool")
    expect(toolSpan.attributes.tool_use_id).toBe("call_1")
    expect(toolSpan.attributes.duration_ms).toBe(500)
    expect(JSON.stringify(toolSpan.attributes)).not.toContain("secret command")
    expect(JSON.stringify(toolSpan.attributes)).not.toContain("secret output")
    expect(logger.records[0]!.body).toBe("claude_code.tool_result")
    expect(logger.records[0]!.attributes!.tool_use_id).toBe("call_1")
  })

  test("correlates an out-of-order tool result with its fallback span", () => {
    const { ctx, tracer, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    handleMessagePartUpdated(toolEvent("completed"), ctx)
    expect(trace.getSpanContext(logger.records[0]!.context!)).toEqual(tracer.spans[0]!.spanContext())
  })

  test("maps permission source and generates a fallback tool use id", () => {
    const { ctx, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    beginPrompt("session_1", "user_1", ctx)
    ctx.pendingPermissions.set("permission_1", { type: "tool", titleLength: 4, sessionID: "session_1" })
    const event = {
      type: "permission.replied",
      properties: { permissionID: "permission_1", sessionID: "session_1", response: "allowAlways" },
    } as EventPermissionReplied
    handlePermissionReplied(event, ctx)
    expect(logger.records[0]!.body).toBe("claude_code.tool_decision")
    expect(logger.records[0]!.attributes!.source).toBe("user_permanent")
    expect(logger.records[0]!.attributes!.tool_use_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("preserves a real permission call id", () => {
    const { ctx, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    ctx.pendingPermissions.set("permission_1", { type: "tool", titleLength: 4, sessionID: "session_1", toolUseID: "call_real" })
    handlePermissionReplied({ type: "permission.replied", properties: { permissionID: "permission_1", sessionID: "session_1", response: "allow" } } as EventPermissionReplied, ctx)
    expect(logger.records[0]!.attributes!.tool_use_id).toBe("call_real")
  })
})
