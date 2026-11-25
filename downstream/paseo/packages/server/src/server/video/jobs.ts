import { describeEditorError } from "./errors.js";
import type { MediaService } from "./media.js";
import type { EditorStore } from "./store.js";

export class EditorJobSupervisor {
  private readonly running = new Map<string, AbortController>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  private closing = false;

  constructor(
    private readonly store: EditorStore,
    private readonly media: MediaService,
    private readonly concurrency = 1,
  ) {}

  start(): void {
    this.schedule();
  }

  enqueue(projectId: string, jobId: string): void {
    if (this.running.has(jobId)) return;
    this.running.set(jobId, new AbortController());
    this.queue.push(() => this.execute(projectId, jobId));
    this.schedule();
  }

  control(
    projectId: string,
    jobId: string,
    action: "cancel" | "pause" | "resume" | "retry",
    requestId: string,
    principal: Parameters<EditorStore["controlJob"]>[0]["principal"],
  ) {
    const controller = this.running.get(jobId);
    const { job, applied } = this.store.controlJob(
      { projectId, jobId, action, requestId, principal },
      controller !== undefined,
    );
    if (!applied) return job;
    if (action === "cancel" || action === "pause") controller?.abort();
    if (action === "retry" || action === "resume") this.enqueue(projectId, jobId);
    return job;
  }

  async stop(): Promise<void> {
    this.closing = true;
    for (const controller of this.running.values()) controller.abort();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.active === 0) return resolve();
        setTimeout(check, 10);
      };
      check();
    });
  }

  private schedule(): void {
    if (this.closing || this.active >= this.concurrency) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active++;
    void next().finally(() => {
      this.active--;
      this.schedule();
    });
  }

  private async execute(projectId: string, jobId: string): Promise<void> {
    const controller = this.running.get(jobId);
    if (!controller) return;
    try {
      const job = this.store.job(projectId, jobId, {
        principalId: "worker",
        role: "owner",
        projectIds: null,
      });
      if (job.state === "cancel_requested") {
        this.store.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "cancelled",
          phaseDetail: "cancelled before execution",
        }));
        return;
      }
      if (job.state === "pausing") {
        this.store.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "paused",
          phaseDetail: "paused before execution",
        }));
        return;
      }
      if (
        job.state === "paused" ||
        [
          "completed",
          "failed",
          "cancelled",
          "awaiting_review",
          "awaiting_delivery_approval",
        ].includes(job.state)
      )
        return;
      await this.media.executeJob(projectId, jobId, controller.signal);
      const settled = this.store.job(projectId, jobId, {
        principalId: "worker",
        role: "owner",
        projectIds: null,
      });
      if (settled.state === "cancel_requested")
        this.store.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "cancelled",
          phaseDetail: "cancelled after execution",
        }));
      else if (settled.state === "pausing")
        this.store.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "paused",
          phaseDetail: "paused at checkpoint",
        }));
    } catch (error) {
      const detail = describeEditorError(error);
      this.store.updateJob(projectId, jobId, (current) => {
        // Honor a requested cancel even if the worker surfaced a non-CANCELLED error during abort,
        // matching the clean-execution path that settles cancel_requested to cancelled.
        if (current.state === "cancel_requested")
          return { ...current, state: "cancelled", phaseDetail: "cancelled after execution", error: undefined };
        if (detail.code === "CANCELLED" && current.state === "pausing")
          return { ...current, state: "paused", phaseDetail: "paused at checkpoint", error: undefined };
        return {
          ...current,
          state: detail.code === "CANCELLED" ? "cancelled" : "failed",
          phaseDetail: detail.sanitizedDetail,
          error: detail,
        };
      });
    } finally {
      this.running.delete(jobId);
    }
  }
}
