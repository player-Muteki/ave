import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DaemonToWorkerSchema,
  IpcChannel,
  WorkerToDaemonSchema,
  type DaemonToWorker,
  type WorkerToDaemon,
  type DaemonInitSchema,
} from "./ipc.js";
import { z } from "zod";
import { createPlannerSession } from "./session.js";
import { editorFailure } from "../errors.js";

/**
 * Independent agent-worker process entry. Owns exactly one Pi AgentSession
 * for one planning run and talks to the daemon only over this stdio JSONL
 * channel. It holds no project DB, no CAS, no grants and no media paths; all
 * persistence and authorization happen daemon-side.
 */

type Init = z.infer<typeof DaemonInitSchema>;

async function main(): Promise<void> {
  const channel = new IpcChannel<DaemonToWorker, WorkerToDaemon>(
    process.stdin,
    process.stdout,
    DaemonToWorkerSchema,
    () => {},
  );

  let init: Init | undefined;
  let session: Awaited<ReturnType<typeof createPlannerSession>> | undefined;
  let workspace: string | undefined;

  const send = (message: WorkerToDaemon) => channel.send(WorkerToDaemonSchema.parse(message));

  // Process exit covers init failures as well as normal stop. Only this process
  // creates the workspace; never delete a directory supplied in an IPC request.
  process.once("exit", () => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });
  let stopping = false;
  async function shutdown(code: number) {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 3000);
    try {
      await session?.abort();
      await session?.dispose();
    } finally {
      clearTimeout(deadline);
      process.exit(code);
    }
  }
  process.stdin.once("end", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  async function dispatch(message: DaemonToWorker) {
    if (stopping) return;
    switch (message.kind) {
      case "init": {
        if (init) editorFailure("INVALID_ARGUMENT", "Duplicate init");
        init = message;
        workspace = mkdtempSync(path.join(tmpdir(), `ave-planner-${message.runId}-`));
        session = await createPlannerSession({
          projectId: message.projectId,
          runId: message.runId,
          sessionId: message.sessionId,
          workspace,
          promptSignature: message.promptSignature,
          channel,
          onEvent: (event) => send({ kind: "event", event }),
        });
        send({
          kind: "hello",
          protocolVersion: "1",
          runId: message.runId,
          sessionId: message.sessionId,
          workerPid: process.pid,
        });
        send({ kind: "run_state", state: "running" });
        break;
      }
      case "prompt":
        if (!session || !init) editorFailure("INVALID_ARGUMENT", "Worker not initialized");
        send({ kind: "run_state", state: "running" });
        await session.prompt(message.text);
        send({ kind: "run_state", state: "settled" });
        break;
      case "steer":
        if (!session) editorFailure("INVALID_ARGUMENT", "Worker not initialized");
        await session.steer(message.text);
        break;
      case "follow_up":
        if (!session) editorFailure("INVALID_ARGUMENT", "Worker not initialized");
        await session.followUp(message.text);
        break;
      case "abort":
        if (session) await session.abort();
        send({ kind: "run_state", state: "interrupted", detail: "aborted by operator" });
        break;
      case "dispose":
        await shutdown(0);
        break;
      case "ping":
        break;
      case "tool_result":
        break;
    }
  }

  channel.setHandler(message => dispatch(message).catch(() => shutdown(1)));
}

void main();
