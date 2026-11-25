import type { EditorEvent, PlanningRunStatus } from "../shared/contracts/v1.js";

export function planningRunUpdate(run: PlanningRunStatus, events: EditorEvent[]) {
  let state = run.state;
  const matchingEvents = events.filter((event) => {
    if (event.projectId !== run.projectId) return false;
    // Agent activity events may only carry the run ID in their payload.
    const payload = event.payload as { runId?: unknown } | null;
    if ((event.runId ?? payload?.runId) !== run.runId) return false;

    switch (event.type) {
      case "run.running":
        state = "running";
        break;
      case "run.awaiting_input":
        state = "awaiting_input";
        break;
      case "run.settled":
        state = "settled";
        break;
      case "run.failed":
        state = "failed";
        break;
      case "run.interrupted":
        state = "interrupted";
        break;
    }
    return true;
  });
  return { run: { ...run, state }, events: matchingEvents };
}
