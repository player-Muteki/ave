import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeEditorError,
  editorFailure,
  type EditorPrincipal,
  type PlanningRunStatus,
  type StartPlanningRunInput,
  type SteerPlanningRunInput,
} from "@ave/contracts";
import {
  DaemonToWorkerSchema,
  IpcChannel,
  WorkerToDaemonSchema,
  type DaemonToWorker,
  type ProviderConfig,
  type WorkerToDaemon,
  videoPlannerPromptSignature,
} from "@ave/planner-worker";
import type { AveStore } from "@ave/sqlite";
import type { PlannerControllerHook } from "./rpc-registry.js";
import type { DaemonQueries } from "./store-queries.js";
import { AveToolBroker } from "./tool-broker.js";

export interface PlannerDefaults {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface AvePlannerControllerOptions {
  store: AveStore;
  queries: DaemonQueries;
  onProjectEvent: (projectId: string) => void;
  providerDefaults?: PlannerDefaults;
  workerEntryPath?: string;
}

interface RunHandle {
  projectId: string;
  runId: string;
  sessionId: string;
  principal: EditorPrincipal;
  child: ChildProcess;
  closed: Promise<void>;
  channel: IpcChannel<WorkerToDaemon, DaemonToWorker>;
  broker: AveToolBroker;
  initialPrompt?: string;
  state: PlanningRunStatus["state"];
  workerPid?: number;
}

export function resolvePlannerWorkerEntry(override?: string): string {
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../planner-worker/dist/worker-main.js");
}

/**
 * Daemon-side controller managing isolated native `@ave/planner-worker` child
 * processes. Owns project authorization, tool execution via AveToolBroker, and
 * durable run/agent event persistence in SQLite.
 */
export class AvePlannerController implements PlannerControllerHook {
  private readonly runs = new Map<string, RunHandle>();
  private readonly store: AveStore;
  private readonly queries: DaemonQueries;
  private readonly onProjectEvent: (projectId: string) => void;
  private readonly providerDefaults: PlannerDefaults;
  private readonly workerEntryPath: string;

  constructor(options: AvePlannerControllerOptions) {
    this.store = options.store;
    this.queries = options.queries;
    this.onProjectEvent = options.onProjectEvent;
    this.providerDefaults = options.providerDefaults ?? {};
    this.workerEntryPath = resolvePlannerWorkerEntry(options.workerEntryPath);
  }

  private resolveProviderConfig(modelOverride?: { provider: string; id: string }): ProviderConfig {
    const baseUrl = this.providerDefaults.baseUrl ?? process.env.AVE_PLANNER_BASE_URL;
    if (!baseUrl) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        "Planner provider endpoint is not configured (set AVE_PLANNER_BASE_URL or daemon planner.baseUrl)",
      );
    }
    const apiKey = this.providerDefaults.apiKey ?? process.env.AVE_PLANNER_API_KEY;
    const model =
      modelOverride?.id ??
      this.providerDefaults.model ??
      process.env.AVE_PLANNER_MODEL ??
      "ave-planner-default";
    return {
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
      maxTurns: this.providerDefaults.maxTurns ?? 12,
      timeoutMs: this.providerDefaults.timeoutMs ?? 30_000,
    };
  }

  async startRun(
    input: StartPlanningRunInput,
    principal: EditorPrincipal,
    desktopAccess?: () => Promise<string>,
  ): Promise<PlanningRunStatus> {
    this.store.devices.authorizeProject(input.projectId, principal, "operator");
    const chatgpt = input.model?.provider === "chatgpt";
    const checkCloud = () => {
      if (!desktopAccess || !input.model || !this.store.projects.cloudModelsAllowed(input.projectId) ||
          !this.store.plans.modelAllowed(input.projectId, "planning", input.model, principal)) {
        editorFailure("PERMISSION_DENIED", "请在本机桌面为此项目启用所选 ChatGPT 云模型");
      }
    };
    let provider: ProviderConfig;
    if (chatgpt) {
      checkCloud();
      const token = await desktopAccess!();
      checkCloud();
      provider = { transport:"chatgpt-responses", baseUrl:"https://api.openai.com/v1", model:input.model!.id,
        apiKey:token, timeoutMs:120000, maxTurns:12 };
    } else {
      provider = this.resolveProviderConfig(input.model);
    }

    if (!existsSync(this.workerEntryPath)) {
      editorFailure(
        "CAPABILITY_UNAVAILABLE",
        `Compiled planner worker entry not found at ${this.workerEntryPath}`,
      );
    }

    const { receipt, created } = this.store.jobs.reservePlanningRun(
      input.projectId,
      input.requestId,
      input.prompt,
      principal,
      input.model,
    );
    if (!created) {
      return {
        projectId: input.projectId,
        runId: receipt.runId,
        sessionId: receipt.sessionId,
        state: receipt.state,
      };
    }

    const { runId, sessionId } = receipt;
    const child = spawn(process.execPath, [this.workerEntryPath], {
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "production",
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });

    const handle: RunHandle = {
      projectId: input.projectId,
      runId,
      sessionId,
      principal,
      child,
      closed,
      channel: undefined as never,
      broker: new AveToolBroker(this.store, this.queries, {
        projectId: input.projectId,
        runId,
        principal,
      }),
      initialPrompt: input.prompt,
      state: "running",
    };

    const channel = new IpcChannel<WorkerToDaemon, DaemonToWorker>(
      child.stdout!,
      child.stdin!,
      WorkerToDaemonSchema,
    );
    handle.channel = channel;
    channel.setHandler((message) => void this.onWorkerMessage(handle, message));

    child.on("error", () => {
      /* terminal failure is recorded in the close handler */
    });
    child.stdin!.on("error", () => {
      /* stdin EPIPE when worker exits */
    });
    child.once("close", (code) => {
      if (handle.state === "running" || handle.state === "awaiting_input") {
        handle.state = "failed";
        this.store.jobs.recordExternalEvent(
          handle.projectId,
          "run.failed",
          { runId, sessionId, exitCode: code },
          handle.principal,
        );
        this.onProjectEvent(handle.projectId);
      }
      this.runs.delete(runId);
    });

    channel.sendValidated(
      {
        kind: "init",
        protocolVersion: "1",
        projectId: input.projectId,
        runId,
        sessionId,
        promptSignature: videoPlannerPromptSignature(),
        provider,
      },
      DaemonToWorkerSchema,
    );

    this.runs.set(runId, handle);
    this.onProjectEvent(input.projectId);
    return {
      runId,
      projectId: input.projectId,
      sessionId,
      state: "running",
    };
  }

  private async onWorkerMessage(handle: RunHandle, message: WorkerToDaemon): Promise<void> {
    if (handle.state === "interrupted" || handle.state === "failed" || handle.state === "settled") {
      return;
    }

    switch (message.kind) {
      case "hello":
        if (
          handle.initialPrompt === undefined ||
          message.runId !== handle.runId ||
          message.sessionId !== handle.sessionId ||
          handle.state !== "running"
        ) {
          break;
        }
        handle.workerPid = message.workerPid;
        handle.channel.sendValidated(
          { kind: "prompt", text: handle.initialPrompt },
          DaemonToWorkerSchema,
        );
        delete handle.initialPrompt;
        break;

      case "tool_call": {
        try {
          const result = await handle.broker.invoke(message.call);
          handle.channel.sendValidated(
            { kind: "tool_result", requestId: message.requestId, ok: true, result },
            DaemonToWorkerSchema,
          );
          this.onProjectEvent(handle.projectId);
        } catch (error) {
          const detail = describeEditorError(error);
          handle.channel.sendValidated(
            {
              kind: "tool_result",
              requestId: message.requestId,
              ok: false,
              error: { code: detail.code, message: detail.sanitizedDetail },
            },
            DaemonToWorkerSchema,
          );
        }
        break;
      }

      case "event":
        this.store.jobs.recordPlannerEvent(
          { projectId: handle.projectId, runId: handle.runId, sessionId: handle.sessionId },
          message.event,
          handle.principal,
        );
        this.onProjectEvent(handle.projectId);
        break;

      case "run_state":
        handle.state = message.state;
        this.store.jobs.recordExternalEvent(
          handle.projectId,
          `run.${message.state}`,
          {
            runId: handle.runId,
            sessionId: handle.sessionId,
            ...(message.detail ? { detail: message.detail } : {}),
            ...(message.planId ? { planId: message.planId } : {}),
            ...(message.planHash ? { planHash: message.planHash } : {}),
            ...(message.error ? { error: message.error } : {}),
          },
          handle.principal,
        );
        this.onProjectEvent(handle.projectId);
        if (
          message.state === "settled" ||
          message.state === "failed" ||
          message.state === "interrupted"
        ) {
          await this.closeWorker(handle);
        }
        break;
    }
  }

  private getActiveRun(runId: string, projectId: string): RunHandle {
    const handle = this.runs.get(runId);
    if (!handle || handle.projectId !== projectId) {
      editorFailure("NOT_FOUND", "No active planning run with this runId");
    }
    return handle;
  }

  async steerRun(
    input: SteerPlanningRunInput,
    principal: EditorPrincipal,
  ): Promise<PlanningRunStatus> {
    this.store.devices.authorizeProject(input.projectId, principal, "operator");
    const handle = this.getActiveRun(input.runId, input.projectId);
    handle.channel.sendValidated({ kind: "steer", text: input.text }, DaemonToWorkerSchema);
    return {
      runId: input.runId,
      projectId: input.projectId,
      sessionId: handle.sessionId,
      state: handle.state,
      ...(handle.workerPid ? { workerPid: handle.workerPid } : {}),
    };
  }

  async followUpRun(
    input: SteerPlanningRunInput,
    principal: EditorPrincipal,
  ): Promise<PlanningRunStatus> {
    this.store.devices.authorizeProject(input.projectId, principal, "operator");
    const handle = this.getActiveRun(input.runId, input.projectId);
    handle.channel.sendValidated({ kind: "follow_up", text: input.text }, DaemonToWorkerSchema);
    return {
      runId: input.runId,
      projectId: input.projectId,
      sessionId: handle.sessionId,
      state: handle.state,
      ...(handle.workerPid ? { workerPid: handle.workerPid } : {}),
    };
  }

  async stopRun(
    projectId: string,
    runId: string,
    principal: EditorPrincipal,
  ): Promise<PlanningRunStatus> {
    this.store.devices.authorizeProject(projectId, principal, "operator");
    const handle = this.runs.get(runId);
    if (!handle || handle.projectId !== projectId) {
      return this.store.jobs.planningRunStatus(projectId, runId, principal);
    }
    if (handle.state === "running" || handle.state === "awaiting_input") {
      handle.state = "interrupted";
      handle.channel.sendValidated({ kind: "abort" }, DaemonToWorkerSchema);
      this.store.jobs.recordExternalEvent(
        projectId,
        "run.interrupted",
        { runId, sessionId: handle.sessionId, reason: "stopped by operator" },
        principal,
      );
      this.onProjectEvent(projectId);
    }
    await this.closeWorker(handle);
    return {
      runId,
      projectId,
      sessionId: handle.sessionId,
      state: handle.state,
    };
  }

  status(projectId: string, runId: string, principal: EditorPrincipal): PlanningRunStatus {
    const handle = this.runs.get(runId);
    if (!handle || handle.projectId !== projectId) {
      return this.store.jobs.planningRunStatus(projectId, runId, principal);
    }
    this.store.devices.authorizeProject(projectId, principal, "viewer");
    return {
      runId,
      projectId,
      sessionId: handle.sessionId,
      state: handle.state,
      ...(handle.workerPid ? { workerPid: handle.workerPid } : {}),
    };
  }

  private async closeWorker(handle: RunHandle): Promise<void> {
    try {
      handle.channel.sendValidated({ kind: "dispose" }, DaemonToWorkerSchema);
    } catch {
      /* channel may already be closed */
    }
    handle.child.stdin?.end();
    const timer = setTimeout(() => handle.child.kill("SIGKILL"), 3000);
    try {
      await handle.closed;
    } finally {
      clearTimeout(timer);
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
      [...this.runs.values()].map(async (handle) => {
        if (handle.state === "running" || handle.state === "awaiting_input") {
          await this.stopRun(handle.projectId, handle.runId, handle.principal);
        } else {
          await this.closeWorker(handle);
        }
      }),
    );
  }
}
