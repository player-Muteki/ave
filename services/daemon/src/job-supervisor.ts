import type { ContentAddressedStore } from "@ave/cas";
import {
  describeEditorError,
  editorFailure,
  type EditorPrincipal,
  type JobSnapshot,
} from "@ave/contracts";
import type { AveStore } from "@ave/sqlite";
import type { DeterministicBackendRegistry } from "./backends/deterministic-backend.js";
import type { AveMediaWorkerBridge } from "./media-worker-bridge.js";

const OWNER_WORKER: EditorPrincipal = {
  principalId: "worker",
  role: "owner",
  projectIds: null,
};

export class AveJobSupervisor {
  private readonly running = new Map<string, AbortController>();
  private readonly queue: Array<() => Promise<void>> = [];
  private active = 0;
  private closing = false;
  private mediaWorker?: AveMediaWorkerBridge;

  constructor(
    private readonly store: AveStore,
    private readonly cas: ContentAddressedStore,
    private readonly backends: DeterministicBackendRegistry,
    private readonly onProjectEvent: (projectId: string) => void = () => {},
    private readonly concurrency = 1,
  ) {}

  setMediaWorker(bridge: AveMediaWorkerBridge): void {
    this.mediaWorker = bridge;
  }

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
    principal: EditorPrincipal,
  ): JobSnapshot {
    const controller = this.running.get(jobId);
    const { job, applied } = this.store.jobs.controlJob(
      { projectId, jobId, action, requestId, principal },
      controller !== undefined,
    );
    if (!applied) return job;
    this.onProjectEvent(projectId);
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
      const job = this.store.jobs.getJob(projectId, jobId, OWNER_WORKER);
      if (job.state === "cancel_requested") {
        this.store.jobs.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "cancelled",
          phaseDetail: "cancelled before execution",
        }));
        this.onProjectEvent(projectId);
        return;
      }
      if (job.state === "pausing") {
        this.store.jobs.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "paused",
          phaseDetail: "paused before execution",
        }));
        this.onProjectEvent(projectId);
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
      ) {
        return;
      }

      await this.runJob(job, controller.signal);

      const settled = this.store.jobs.getJob(projectId, jobId, OWNER_WORKER);
      if (settled.state === "cancel_requested") {
        this.store.jobs.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "cancelled",
          phaseDetail: "cancelled after execution",
        }));
        this.onProjectEvent(projectId);
      } else if (settled.state === "pausing") {
        this.store.jobs.updateJob(projectId, jobId, (current) => ({
          ...current,
          state: "paused",
          phaseDetail: "paused at checkpoint",
        }));
        this.onProjectEvent(projectId);
      }
    } catch (error) {
      const detail = describeEditorError(error);
      this.store.jobs.updateJob(projectId, jobId, (current) => {
        if (current.state === "cancel_requested") {
          return {
            ...current,
            state: "cancelled",
            phaseDetail: "cancelled after execution",
            error: undefined,
          };
        }
        if (detail.code === "CANCELLED" && current.state === "pausing") {
          return {
            ...current,
            state: "paused",
            phaseDetail: "paused at checkpoint",
            error: undefined,
          };
        }
        return {
          ...current,
          state: detail.code === "CANCELLED" ? "cancelled" : "failed",
          phaseDetail: detail.sanitizedDetail,
          error: detail,
        };
      });
      this.onProjectEvent(projectId);
    } finally {
      this.running.delete(jobId);
    }
  }

  private async runJob(job: JobSnapshot, signal: AbortSignal): Promise<void> {
    const backend = this.backends.get("ffmpeg");
    const project = this.store.projects.getProjectSnapshot(job.projectId, OWNER_WORKER);

    if (job.kind === "analysis") {
      if (job.objectTask) {
        if (!this.mediaWorker) editorFailure("CAPABILITY_UNAVAILABLE", "Object worker is unavailable");
        await this.mediaWorker.runObjectTask(job, signal);
        return;
      }
      const tracking = this.store.jobs.trackingRequest(job.projectId, job.jobId);
      if (tracking) {
        if (!this.mediaWorker) {
          editorFailure(
            "CAPABILITY_UNAVAILABLE",
            "Mask tracking worker is not attached",
          );
        }
        await this.mediaWorker.runTrackMaskJob(job, tracking, signal);
        return;
      }
      if (!job.analysisAssetId) {
        editorFailure("INVALID_ARGUMENT", "Analysis job has no target asset");
      }
      const asset = project.assets.find((a) => a.assetId === job.analysisAssetId);
      if (!asset) editorFailure("ASSET_NOT_FOUND", "Analysis asset is missing");
      const res = await backend.analyzeAsset({
        job,
        asset,
        cas: this.cas,
        rate: job.analysisRate ?? "25/1",
        signal,
      });
      this.store.jobs.updateJob(job.projectId, job.jobId, (current) => ({
        ...current,
        state: "completed",
        phaseDetail: "analysis complete",
        progress: { completedUnits: String(res.units), totalUnits: String(res.units) },
        artifacts: [
          ...current.artifacts,
          res.analysisQa,
          res.sceneCuts,
          ...(res.waveform ? [res.waveform] : []),
        ],
        error: undefined,
      }));
      this.onProjectEvent(job.projectId);
      return;
    }

    const plan = project.plans.find((p) => p.planHash === job.planHash);
    if (!plan) editorFailure("PROJECT_NOT_FOUND", "The approved plan is unavailable");

    if (job.kind === "export") {
      const { candidate, qa } = this.store.jobs.deliveryInputs(job);
      const { output, manifest } = await backend.deliverExport({
        job,
        plan,
        candidate,
        qa,
        cas: this.cas,
        signal,
      });
      this.store.jobs.finishDelivery(job, output, manifest);
      this.onProjectEvent(job.projectId);
      return;
    }

    const renderBackend = this.backends.get(plan.deterministicBackendId);
    const assets = new Map(project.assets.map((a) => [a.assetId, a]));
    const single = plan.trimOperations.length === 1 ? plan.trimOperations[0] : undefined;
    const source = single && assets.get(single.source.assetId);
    const stream = source?.streams.find(s => s.streamUid === single!.source.streamUid);
    const constantRate = source && stream && this.store.projects.hasConstantRate(source.presentationIndex.sha256, stream.streamUid)
      ? stream.averageRate : undefined;
    const rendered = await renderBackend.renderPlan({
      job,
      plan,
      assets,
      constantRate,
      generateShot: this.mediaWorker?.generateShot.bind(this.mediaWorker),
      cas: this.cas,
      signal,
    });
    this.store.jobs.finishCandidate(job, rendered.candidate, rendered.qa, rendered.reviewProxy);
    this.onProjectEvent(job.projectId);
  }
}
