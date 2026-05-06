import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventSessionDiff, EventCommandExecuted } from "@opencode-ai/sdk"
import { isMetricEnabled } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/**
 * Records lines-added/removed for a `session.diff` event. opencode publishes each event
 * with the cumulative session diff (first snapshot → latest), so we emit two instruments:
 * `opencode.lines_of_code.count` (Counter) receives only the positive delta since the
 * previous event for this session, so summing across a session yields the net total without
 * double counting. `opencode.lines_of_code.total` (Gauge) records the current cumulative
 * total, overwritten on every event.
 */
export function handleSessionDiff(e: EventSessionDiff, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const linesEnabled = isMetricEnabled("lines_of_code.count", ctx)
  const totalEnabled = isMetricEnabled("lines_of_code.total", ctx)
  let totalAdded = 0
  let totalRemoved = 0
  for (const fileDiff of e.properties.diff) {
    totalAdded += fileDiff.additions
    totalRemoved += fileDiff.deletions
  }

  const prev = ctx.sessionDiffTotals.get(sessionID) ?? { additions: 0, deletions: 0 }
  const deltaAdded = totalAdded - prev.additions
  const deltaRemoved = totalRemoved - prev.deletions
  ctx.sessionDiffTotals.set(sessionID, { additions: totalAdded, deletions: totalRemoved })

  const baseAttrs = { ...ctx.commonAttrs, "session.id": sessionID }

  if (linesEnabled) {
    if (deltaAdded > 0) {
      ctx.instruments.linesCounter.add(deltaAdded, { ...baseAttrs, type: "added" })
    }
    if (deltaRemoved > 0) {
      ctx.instruments.linesCounter.add(deltaRemoved, { ...baseAttrs, type: "removed" })
    }
  }
  if (totalEnabled) {
    ctx.instruments.linesTotalGauge.record(totalAdded, { ...baseAttrs, type: "added" })
    ctx.instruments.linesTotalGauge.record(totalRemoved, { ...baseAttrs, type: "removed" })
  }

  ctx.log("debug", "otel: lines_of_code metrics updated", {
    sessionID,
    files: e.properties.diff.length,
    deltaAdded,
    deltaRemoved,
    totalAdded,
    totalRemoved,
  })
}

const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/

/** Detects `git commit` invocations in bash tool calls and increments the commit counter and emits a `commit` log event. */
export function handleCommandExecuted(e: EventCommandExecuted, ctx: HandlerContext) {
  if (e.properties.name !== "bash") return
  ctx.log("debug", "otel: command.executed (bash)", { sessionID: e.properties.sessionID, argumentsLength: e.properties.arguments.length })
  if (!GIT_COMMIT_RE.test(e.properties.arguments)) return

  if (isMetricEnabled("commit.count", ctx)) {
    ctx.instruments.commitCounter.add(1, {
      ...ctx.commonAttrs,
      "session.id": e.properties.sessionID,
    })
    ctx.log("debug", "otel: commit counter incremented", { sessionID: e.properties.sessionID })
  }
  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "commit",
    attributes: {
      "event.name": "commit",
      "session.id": e.properties.sessionID,
      ...ctx.commonAttrs,
    },
  })
}
