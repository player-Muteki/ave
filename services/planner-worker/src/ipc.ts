import { createHash, randomUUID } from "node:crypto";
import {
  EditorErrorSchema,
  EditorEventSchema,
  VideoToolCallSchema,
  type EditorEvent,
} from "@ave/contracts";
import { z } from "zod";

export type VideoToolCall = z.infer<typeof VideoToolCallSchema>;

export const IPC_PROTOCOL_VERSION = "1" as const;

const id = z.string().min(1).max(128);

export const ProviderConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    transport: z.literal("chatgpt-responses").optional(),
    apiKey: z.string().optional(),
    model: z.string().min(1),
    maxTurns: z.number().int().min(1).max(32).default(12),
    timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const WorkerHelloSchema = z
  .object({
    kind: z.literal("hello"),
    protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
    runId: id,
    sessionId: id,
    workerPid: z.number().int(),
  })
  .strict();

export const ToolCallMessageSchema = z
  .object({
    kind: z.literal("tool_call"),
    requestId: id,
    call: VideoToolCallSchema,
  })
  .strict();

export const WorkerEventMessageSchema = z
  .object({
    kind: z.literal("event"),
    event: EditorEventSchema,
  })
  .strict();

export const RunStateMessageSchema = z
  .object({
    kind: z.literal("run_state"),
    state: z.enum(["running", "awaiting_input", "settled", "interrupted", "failed"]),
    detail: z.string().max(2000).optional(),
    planId: id.optional(),
    planHash: z.string().optional(),
    error: EditorErrorSchema.optional(),
  })
  .strict();

export const WorkerToDaemonSchema = z.discriminatedUnion("kind", [
  WorkerHelloSchema,
  ToolCallMessageSchema,
  WorkerEventMessageSchema,
  RunStateMessageSchema,
]);

export const DaemonInitSchema = z
  .object({
    kind: z.literal("init"),
    protocolVersion: z.literal(IPC_PROTOCOL_VERSION),
    projectId: id,
    runId: id,
    sessionId: id,
    promptSignature: z.string().regex(/^[0-9a-f]{64}$/),
    provider: ProviderConfigSchema,
    history: z.array(z.object({ prompt: z.string().max(2000), reply: z.string().max(2000) })).max(8).optional(),
  })
  .strict();

export const PromptMessageSchema = z
  .object({
    kind: z.enum(["prompt", "steer", "follow_up"]),
    text: z.string().min(1).max(64_000),
  })
  .strict();

export const ControlMessageSchema = z
  .object({
    kind: z.enum(["abort", "dispose", "ping"]),
  })
  .strict();

export const ToolResultMessageSchema = z
  .object({
    kind: z.literal("tool_result"),
    requestId: id,
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();

export const DaemonToWorkerSchema = z.discriminatedUnion("kind", [
  DaemonInitSchema,
  PromptMessageSchema,
  ControlMessageSchema,
  ToolResultMessageSchema,
]);

export type WorkerToDaemon = z.infer<typeof WorkerToDaemonSchema>;
export type DaemonToWorker = z.infer<typeof DaemonToWorkerSchema>;
export type ToolResultMessage = z.infer<typeof ToolResultMessageSchema>;
export type PlannerWorkerEvent = EditorEvent;
export type ValidatedVideoToolCall = VideoToolCall;

export function newRequestId(): string {
  return randomUUID();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Typed JSONL-over-stdio channel linking the isolated planner-worker process
 * with the daemon's AvePlannerController.
 */
export class IpcChannel<In extends { kind: string }, Out> {
  private buffer = "";
  private readonly pending = new Map<
    string,
    { settle: (value: In) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  private onMessage: (message: In) => void | Promise<void>;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly inSchema: z.ZodType<In>,
    onMessage: (message: In) => void | Promise<void> = () => {},
    private readonly requestTimeoutMs = 120_000,
  ) {
    this.onMessage = onMessage;
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.feed(chunk));
    input.on("end", () => this.failAll(new Error("IPC channel closed")));
    input.on("error", (error) => this.failAll(error));
  }

  setHandler(handler: (message: In) => void | Promise<void>): void {
    this.onMessage = handler;
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const message = this.inSchema.safeParse(parsed);
      if (!message.success) continue;
      const data = message.data;
      if ("requestId" in data && data.kind === "tool_result") {
        const reqId = (data as { requestId: string }).requestId;
        const entry = this.pending.get(reqId);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(reqId);
          entry.settle(data);
          continue;
        }
      }
      void this.onMessage(data);
    }
  }

  send(message: Out): void {
    this.output.write(JSON.stringify(message) + "\n");
  }

  sendValidated(message: Out, outSchema: z.ZodType<Out>): void {
    this.output.write(JSON.stringify(outSchema.parse(message)) + "\n");
  }

  request(message: Out & { requestId: string }): Promise<In> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error(`IPC request ${message.requestId} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(message.requestId, { settle: resolve, reject, timer });
      this.output.write(JSON.stringify(message) + "\n");
    });
  }

  private failAll(error: Error): void {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}
