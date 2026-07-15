import { describe, expect, test } from "bun:test"
import { createTelemetryProfile } from "../src/schema.ts"

describe("telemetry profiles", () => {
  test("keeps opencode names configurable", () => {
    const profile = createTelemetryProfile("opencode", "custom.")
    expect(profile.metricPrefix).toBe("custom.")
    expect(profile.eventBody("api_request")).toBe("api_request")
    expect(profile.spanName("interaction")).toBe("custom.session")
    expect(profile.spanName("llm_request")).toBe("custom.llm")
    expect(profile.spanName("tool", "bash")).toBe("custom.tool.bash")
    expect(profile.metricUnit("session.count", "{session}")).toBe("{session}")
  })

  test("uses fixed Claude Code compatible names", () => {
    const profile = createTelemetryProfile("claude-code", "ignored.")
    expect(profile.metricPrefix).toBe("claude_code.")
    expect(profile.eventBody("api_request")).toBe("claude_code.api_request")
    expect(profile.eventBody("session.idle")).toBeUndefined()
    expect(profile.spanName("interaction")).toBe("claude_code.interaction")
    expect(profile.spanName("llm_request")).toBe("claude_code.llm_request")
    expect(profile.spanName("tool", "bash")).toBe("claude_code.tool")
    expect(profile.schemaAttrs["telemetry.schema.name"]).toBe("claude-code")
    expect(profile.metricUnit("session.count", "{session}")).toBe("count")
    expect(profile.metricUnit("lines_of_code.count", "{line}")).toBe("count")
    expect(profile.metricUnit("commit.count", "{commit}")).toBe("count")
  })
})
