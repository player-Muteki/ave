import { editorFailure } from "@ave/contracts";
import {
  DaemonToWorkerSchema,
  IPC_PROTOCOL_VERSION,
  IpcChannel,
  WorkerToDaemonSchema,
  newRequestId,
  type DaemonToWorker,
  type ToolResultMessage,
  type VideoToolCall,
  type WorkerToDaemon,
} from "./ipc.js";
import { NativePlannerLoop } from "./planner-loop.js";
import { videoPlannerPromptSignature } from "./prompt.js";
import { OpenAiCompatibleProvider } from "./provider.js";

/**
 * Isolated native AVE planner-worker process entrypoint.
 * Communicates strictly over JSONL stdio with the daemon controller,
 * never opening SQLite, CAS, or local filesystem paths.
 */
function main(): void {
  const channel = new IpcChannel<DaemonToWorker, WorkerToDaemon>(
    process.stdin,
    process.stdout,
    DaemonToWorkerSchema,
  );

  let loop: NativePlannerLoop | undefined;
  let started = false;
  let disposing = false;

  const invokeTool = async (call: VideoToolCall): Promise<unknown> => {
    const reply = (await channel.request({
      kind: "tool_call",
      requestId: newRequestId(),
      call,
    } as WorkerToDaemon & { requestId: string })) as ToolResultMessage;
    if (!reply.ok) {
      editorFailure(
        reply.error?.code ?? "TOOL_FAILED",
        reply.error?.message ?? "Daemon tool execution failed",
      );
    }
    return reply.result;
  };

  channel.setHandler(async (message) => {
    switch (message.kind) {
      case "ping":
        break;
      case "init": {
        if (loop) return;
        if (message.promptSignature !== videoPlannerPromptSignature()) {
          channel.sendValidated(
            {
              kind: "run_state",
              state: "failed",
              detail: "VIDEO_PLANNER_PROMPT signature mismatch",
              error: {
                code: "PERMISSION_DENIED",
                retryable: false,
                sanitizedDetail: "VIDEO_PLANNER_PROMPT signature mismatch",
              },
            },
            WorkerToDaemonSchema,
          );
          process.exitCode = 1;
          return;
        }
        const provider = new OpenAiCompatibleProvider(message.provider);
        loop = new NativePlannerLoop({
          projectId: message.projectId,
          runId: message.runId,
          sessionId: message.sessionId,
          promptSignature: message.promptSignature,
          provider,
          maxTurns: message.provider.maxTurns,
          callTool: invokeTool,
          onEvent: (event) => {
            channel.sendValidated({ kind: "event", event }, WorkerToDaemonSchema);
          },
        });
        channel.sendValidated(
          {
            kind: "hello",
            protocolVersion: IPC_PROTOCOL_VERSION,
            runId: message.runId,
            sessionId: message.sessionId,
            workerPid: process.pid,
          },
          WorkerToDaemonSchema,
        );
        break;
      }
      case "prompt": {
        if (!loop || started) return;
        started = true;
        void loop.execute(message.text).then((outcome) => {
          if (disposing) return;
          if (outcome.status === "settled") {
            channel.sendValidated(
              {
                kind: "run_state",
                state: "settled",
                detail: outcome.summary,
                ...(outcome.planId ? { planId: outcome.planId } : {}),
                ...(outcome.planHash ? { planHash: outcome.planHash } : {}),
              },
              WorkerToDaemonSchema,
            );
          } else if (outcome.status === "interrupted") {
            channel.sendValidated(
              {
                kind: "run_state",
                state: "interrupted",
                detail: outcome.reason,
              },
              WorkerToDaemonSchema,
            );
          } else {
            channel.sendValidated(
              {
                kind: "run_state",
                state: "failed",
                detail: outcome.error.sanitizedDetail,
                error: outcome.error,
              },
              WorkerToDaemonSchema,
            );
          }
        });
        break;
      }
      case "steer":
        loop?.steer(message.text);
        break;
      case "follow_up":
        loop?.followUp(message.text);
        break;
      case "abort":
        loop?.abort();
        break;
      case "dispose":
        disposing = true;
        loop?.abort();
        process.stdin.pause();
        break;
    }
  });
}

main();
