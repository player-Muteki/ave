import { expect, it } from "vitest";
import { planningRunUpdate } from "../client/planning-events.js";
import type { EditorEvent, PlanningRunStatus } from "../shared/contracts/v1.js";

const run: PlanningRunStatus = {
  projectId: "project", runId: "current", sessionId: "session", state: "running",
};

function event(seq: string, type: string, fields: Partial<EditorEvent> = {}): EditorEvent {
  return {
    protocolVersion: "1", projectId: run.projectId, eventId: seq, seq,
    occurredAt: "2026-11-25T12:00:00Z", type, payload: null, ...fields,
  };
}

it("shows only the current run's events and applies its latest lifecycle state", () => {
  const tool = event("1", "agent.tool_execution_start", { payload: { runId: run.runId } });
  const settled = event("3", "run.settled", { runId: run.runId });
  const result = planningRunUpdate(run, [
    tool,
    event("2", "run.failed", { runId: "other" }),
    settled,
    event("4", "run.interrupted", { projectId: "another-project", runId: run.runId }),
  ]);
  expect(result.events).toEqual([tool, settled]);
  expect(result.run).toEqual({ ...run, state: "settled" });
});

it("preserves the state when no recognized lifecycle event has arrived", () => {
  const status = { ...run, state: "awaiting_input" as const };
  expect(planningRunUpdate(status, [event("6", "run.other", { runId: run.runId })]).run).toEqual(status);
  expect(planningRunUpdate(status, [])).toEqual({ run: status, events: [] });
});
