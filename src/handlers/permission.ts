import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventPermissionUpdated, EventPermissionReplied } from "@opencode-ai/sdk"
import { agentAttrs, emitTelemetryEvent, getSessionAgentMeta, resolveSessionTraceContext, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/** Stores a pending permission prompt in the context map for later correlation with its reply. */
export function handlePermissionUpdated(e: EventPermissionUpdated, ctx: HandlerContext) {
  const perm = e.properties
  setBoundedMap(ctx.pendingPermissions, perm.id, {
    type: perm.type,
    titleLength: perm.title.length,
    sessionID: perm.sessionID,
    messageID: perm.messageID,
    toolUseID: perm.callID ?? crypto.randomUUID(),
    promptID: ctx.promptContextsByRun.get(ctx.assistantRuns.get(perm.messageID) ?? perm.messageID)?.promptID
      ?? ctx.promptContexts.get(perm.sessionID)?.promptID,
  })
  ctx.log("debug", "otel: permission stored", { permissionID: perm.id, sessionID: perm.sessionID, type: perm.type, titleLength: perm.title.length })
}

/** Emits a `tool_decision` log event recording whether the permission was accepted or rejected. */
export function handlePermissionReplied(e: EventPermissionReplied, ctx: HandlerContext) {
  const { permissionID, sessionID, response } = e.properties
  const pending = ctx.pendingPermissions.get(permissionID)
  ctx.pendingPermissions.delete(permissionID)
  const decision = response === "allow" || response === "allowAlways" ? "accept" : "reject"
  const source = response === "allowAlways"
    ? "user_permanent"
    : response === "allow"
      ? "user_temporary"
      : "user_reject"
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  ctx.log("debug", "otel: tool_decision emitted", { permissionID, sessionID, decision, source: response, tool_name: pending?.type ?? "unknown" })
  const now = Date.now()
  const decisionContext = pending
    ? resolveSessionTraceContext(sessionID, ctx, { assistantMessageID: pending.messageID })
    : undefined
  emitTelemetryEvent(ctx, {
    eventName: "tool_decision",
    sessionID,
    timestamp: now,
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    context: decisionContext,
    runID: pending?.messageID ? ctx.assistantRuns.get(pending.messageID) ?? pending.messageID : undefined,
    promptID: pending?.promptID,
    attributes: {
      tool_name: pending?.type ?? "unknown",
      tool_type: pending?.type ?? "unknown",
      ...(pending ? { tool_title_length: pending.titleLength } : {}),
      decision,
      source: ctx.profile.name === "claude-code" ? source : response,
      ...(ctx.profile.name === "claude-code" ? { tool_use_id: pending?.toolUseID ?? crypto.randomUUID() } : {}),
      ...agentAttrs(agentName, agentType),
    },
  })
}
