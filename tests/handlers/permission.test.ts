import { describe, test, expect } from "bun:test"
import { handlePermissionUpdated, handlePermissionReplied } from "../../src/handlers/permission.ts"
import { makeCtx } from "../helpers.ts"
import type { EventPermissionUpdated, EventPermissionReplied } from "@opencode-ai/sdk"

function makePermissionUpdated(id: string, sessionID = "ses_1"): EventPermissionUpdated {
  return {
    type: "permission.updated",
    properties: {
      id,
      type: "tool",
      title: "Read file",
      sessionID,
      messageID: "msg_1",
      callID: "call_1",
      metadata: {},
      time: { created: Date.now() },
    },
  } as unknown as EventPermissionUpdated
}

function makePermissionReplied(
  permissionID: string,
  response: string,
  sessionID = "ses_1",
): EventPermissionReplied {
  return {
    type: "permission.replied",
    properties: { permissionID, sessionID, response },
  } as unknown as EventPermissionReplied
}

describe("handlePermissionUpdated", () => {
  test("stores permission in pendingPermissions", () => {
    const { ctx } = makeCtx()
    handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    expect(ctx.pendingPermissions.has("perm_1")).toBe(true)
    expect(ctx.pendingPermissions.get("perm_1")!.titleLength).toBe(9)
    expect(ctx.pendingPermissions.get("perm_1")!.sessionID).toBe("ses_1")
  })
})

describe("handlePermissionReplied", () => {
  test("emits a temporary accept decision on once", () => {
    const { ctx, logger } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "review", agentType: "subagent" })
    handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    handlePermissionReplied(makePermissionReplied("perm_1", "once"), ctx)
    const record = logger.records.at(0)!
    expect(record.body).toBe("tool_decision")
    expect(record.attributes?.["decision"]).toBe("accept")
    expect(record.attributes?.["source"]).toBe("once")
    expect(record.attributes?.["tool_name"]).toBe("tool")
    expect(record.attributes?.["tool_type"]).toBe("tool")
    expect(record.attributes?.["agent.name"]).toBe("review")
    expect(record.attributes?.["agent.type"]).toBe("subagent")
  })

  test("emits an accept decision on always", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    handlePermissionReplied(makePermissionReplied("perm_1", "always"), ctx)
    expect(logger.records.at(0)!.attributes?.["decision"]).toBe("accept")
  })

  test("emits reject decision on reject", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    handlePermissionReplied(makePermissionReplied("perm_1", "reject"), ctx)
    expect(logger.records.at(0)!.attributes?.["decision"]).toBe("reject")
  })

  test("treats an unknown response as always", () => {
    const { ctx, logger } = makeCtx("project", [], [], true, {}, "claude-code")
    handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    handlePermissionReplied(makePermissionReplied("perm_1", "unknown"), ctx)
    expect(logger.records.at(0)!.attributes?.["decision"]).toBe("accept")
    expect(logger.records.at(0)!.attributes?.["source"]).toBe("user_permanent")
  })

  test("removes permission from pendingPermissions after reply", () => {
    const { ctx } = makeCtx()
    handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    expect(ctx.pendingPermissions.size).toBe(1)
    handlePermissionReplied(makePermissionReplied("perm_1", "once"), ctx)
    expect(ctx.pendingPermissions.size).toBe(0)
  })

  test("uses 'unknown' for tool_name when no pending entry", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionReplied(makePermissionReplied("perm_missing", "once"), ctx)
    expect(logger.records.at(0)!.attributes?.["tool_name"]).toBe("unknown")
    expect(logger.records.at(0)!.attributes?.["tool_type"]).toBe("unknown")
  })
})
