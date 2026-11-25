import type { EditorPrincipal, JobSnapshot } from "#video-editor/contracts/v1";
import { expect, it } from "vitest";
import { EditorError } from "./errors.js";
import { EditorJobSupervisor } from "./jobs.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EditorService } from "./service.js";

const principal: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };

type ControlAction = "cancel" | "pause" | "resume" | "retry";
type JobState = JobSnapshot["state"];
type StoreParam = ConstructorParameters<typeof EditorJobSupervisor>[0];
type MediaParam = ConstructorParameters<typeof EditorJobSupervisor>[1];

function makeJob(state: JobState): JobSnapshot {
  return {
    jobId: "job",
    projectId: "project",
    revision: "1",
    planHash: "a".repeat(64),
    kind: "preview",
    state,
    artifacts: [],
  };
}

function harness(initial: JobState, execute?: (signal: AbortSignal) => Promise<void>) {
  let current = makeJob(initial);
  let transition: (job: JobSnapshot, action: ControlAction) => JobSnapshot = (job) => job;
  const signals: AbortSignal[] = [];
  let executions = 0;

  const receipts = new Map<string, JobSnapshot>();
  const store = {
    controlJob(
      { action, requestId }: { action: ControlAction; requestId: string },
      hasWorker: boolean,
    ) {
      const receipt = receipts.get(requestId);
      if (receipt) return { job: receipt, applied: false };
      current = transition(current, action);
      if (!hasWorker && (action === "cancel" || action === "pause"))
        current = {
          ...current,
          state: action === "cancel" ? "cancelled" : "paused",
          phaseDetail: `${action === "cancel" ? "cancelled" : "paused"} without an active worker`,
        };
      receipts.set(requestId, current);
      return { job: current, applied: true };
    },
    job() {
      return current;
    },
    updateJob(_projectId: string, _jobId: string, update: (job: JobSnapshot) => JobSnapshot) {
      current = update(current);
      return current;
    },
  };
  const media = {
    async executeJob(_projectId: string, _jobId: string, signal: AbortSignal) {
      executions++;
      signals.push(signal);
      await execute?.(signal);
      return current;
    },
  };
  const supervisor = new EditorJobSupervisor(
    store as unknown as StoreParam,
    media as unknown as MediaParam,
  );
  return {
    supervisor,
    setTransition(fn: typeof transition) {
      transition = fn;
    },
    state: () => current.state,
    phaseDetail: () => current.phaseDetail,
    error: () => current.error,
    signals,
    executions: () => executions,
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("cancel aborts a running job and records cancellation before execution", async () => {
  const h = harness("rendering_preview");
  h.setTransition((job) => ({ ...job, state: "cancel_requested" }));
  h.supervisor.enqueue("project", "job");
  h.supervisor.control("project", "job", "cancel", "cancel-1", principal);
  await tick();
  expect(h.signals[0]?.aborted).toBe(true);
  expect(h.state()).toBe("cancelled");
  expect(h.phaseDetail()).toContain("cancelled");
});

it("pause before execution moves an active job to paused without running media", async () => {
  const h = harness("rendering_final");
  h.setTransition((job) => ({ ...job, state: "pausing" }));
  h.supervisor.control("project", "job", "pause", "pause-1", principal);
  h.supervisor.enqueue("project", "job");
  await tick();
  expect(h.executions()).toBe(0);
  expect(h.state()).toBe("paused");
  expect(h.phaseDetail()).toContain("paused");
});

it("resume and retry re-enqueue a finished job", async () => {
  const h = harness("rendering_preview");
  h.setTransition((job) => ({ ...job, state: "rendering_preview", phaseDetail: "queued" }));
  h.supervisor.enqueue("project", "job");
  await tick();
  expect(h.executions()).toBe(1);
  h.supervisor.control("project", "job", "resume", "resume-1", principal);
  await tick();
  expect(h.executions()).toBe(2);
  h.supervisor.control("project", "job", "retry", "retry-1", principal);
  await tick();
  expect(h.executions()).toBe(3);
});

it("records a sanitized failure for an execution error", async () => {
  const h = harness("rendering_preview", async (signal) => {
    if (!signal.aborted) throw new EditorError("FFMPEG_FAILED", "render failed", true);
  });
  h.supervisor.enqueue("project", "job");
  await tick();
  expect(h.state()).toBe("failed");
  expect(h.error()).toMatchObject({ code: "FFMPEG_FAILED", retryable: true });
});

it("maps a worker CANCELLED error to the cancelled state", async () => {
  const h = harness("rendering_preview", async () => {
    throw new EditorError("CANCELLED", "cancelled by worker");
  });
  h.supervisor.enqueue("project", "job");
  await tick();
  expect(h.state()).toBe("cancelled");
});

it("pause aborts the running media and settles a pausing job as paused", async () => {
  const h = harness("rendering_preview", async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (signal.aborted) throw new EditorError("CANCELLED", "The media job was cancelled");
  });
  h.setTransition((job) => ({ ...job, state: "pausing" }));
  h.supervisor.enqueue("project", "job");
  h.supervisor.control("project", "job", "pause", "pause-run", principal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.signals[0]?.aborted).toBe(true);
  expect(h.state()).toBe("paused");
});

it("a genuine worker failure during pausing settles failed, not silently paused", async () => {
  const h = harness("rendering_preview", async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Abort surfaces a real render error rather than a clean CANCELLED.
    if (signal.aborted) throw new EditorError("FFMPEG_FAILED", "render failed", true);
  });
  h.setTransition((job) => ({ ...job, state: "pausing" }));
  h.supervisor.enqueue("project", "job");
  h.supervisor.control("project", "job", "pause", "pause-fail", principal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.signals[0]?.aborted).toBe(true);
  expect(h.state()).toBe("failed");
  expect(h.error()?.code).toBe("FFMPEG_FAILED");
});

it("preserves pause and cancel during full candidate decode, distinct from a bad file", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "decode-control-"));
  const editor = await EditorService.create({ paseoHome: home });
  try {
    await editor.start();
    const blob = await editor.cas.writeBytes(Buffer.from("not a media file"), "video/mp4");
    await expect(editor.media.verifyCandidateDecode(blob, new AbortController().signal))
      .rejects.toMatchObject({ code: "QA_FAILED" });
    await expect(editor.media.verifyCandidateDecode(blob, AbortSignal.abort()))
      .rejects.toMatchObject({ code: "CANCELLED" });
    for (const action of ["pause", "cancel"] as const) {
      const h = harness("rendering_final", signal => editor.media.verifyCandidateDecode(blob, signal));
      h.setTransition(job => ({ ...job, state: action === "pause" ? "pausing" : "cancel_requested" }));
      h.supervisor.enqueue("project", "job");
      // enqueue starts media synchronously; issue the control before FFmpeg's close callback.
      h.supervisor.control("project", "job", action, action, principal);
      await expect.poll(h.state).toBe(action === "pause" ? "paused" : "cancelled");
      await h.supervisor.stop();
    }
  } finally {
    await editor.stop();
    await rm(home, { recursive: true, force: true });
  }
});

it("a replayed retry receipt never launches a second worker", async () => {
  const h = harness("failed");
  h.setTransition(job => ({ ...job, state: "rendering_preview" }));
  const retry = () => h.supervisor.control("project", "job", "retry", "same-retry", principal);
  const receipt = retry();
  await tick();
  expect(retry()).toEqual(receipt);
  await tick();
  expect(h.executions()).toBe(1);
});

it("honors a requested cancel even when the worker errors during abort", async () => {
  const h = harness("rendering_preview", async (signal) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Abort can surface as a render error rather than a clean CANCELLED; the cancel still wins.
    if (signal.aborted) throw new EditorError("FFMPEG_FAILED", "render failed", true);
  });
  h.setTransition((job) => ({ ...job, state: "cancel_requested" }));
  h.supervisor.enqueue("project", "job");
  h.supervisor.control("project", "job", "cancel", "cancel-err", principal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.signals[0]?.aborted).toBe(true);
  expect(h.state()).toBe("cancelled");
  expect(h.error()).toBeUndefined();
});
