import {
  EditorError,
  decodeFramedChunk,
  type ApprovalDecision,
  type ApprovalRequest,
  type CapabilitySet,
  type CreateJobRequestSchema,
  type CreateProjectInputSchema,
  type DecideApprovalResultSchema,
  type EditorEvent,
  type EditorPrincipal,
  type EventsResultSchema,
  type GetMutationResultResultSchema,
  type JobControlRequestSchema,
  type JobSnapshot,
  type PlanReviewRequestSchema,
  type PlanReviewResultSchema,
  type ProjectSnapshot,
  type RevokeApprovalRequest,
  type VerifyExportResult,
} from "@ave/contracts";
import {
  AVE_WS_PROTOCOL_VERSION,
  WsServerMessageSchema,
  base64ToBytes,
  bytesToBase64,
  decodeWsBinaryFrame,
  encodeWsBinaryFrame,
  type WsAuth,
  type WsClientMessage,
  type WsServerMessage,
} from "@ave/protocol";
import type { z } from "zod";

export interface WebSocketLike {
  readyState: number;
  binaryType?: string;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (...args: unknown[]) => void): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface AveClientOptions {
  url: string;
  auth: WsAuth;
  WebSocketImpl?: WebSocketConstructor;
  reconnect?: boolean;
  reconnectBaseMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  binary: boolean;
}

interface SubscriptionEntry {
  projectId: string;
  lastSeq: string;
  listeners: Set<(event: EditorEvent) => void>;
}

const WS_OPEN = 1;

function nextCorrelationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function rawMessageToTextOrBytes(raw: unknown): Promise<{ text?: string; bytes?: Uint8Array }> {
  if (typeof raw === "string") return { text: raw };
  if (raw instanceof Uint8Array) return { bytes: raw };
  if (raw instanceof ArrayBuffer) return { bytes: new Uint8Array(raw) };
  if (typeof Blob !== "undefined" && raw instanceof Blob) {
    return { bytes: new Uint8Array(await raw.arrayBuffer()) };
  }
  if (Array.isArray(raw)) {
    const parts = raw.map((chunk) => (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer)));
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    return { bytes: merged };
  }
  return { text: String(raw) };
}

export class AveClient {
  private ws: WebSocketLike | null = null;
  private principal: EditorPrincipal | null = null;
  private closedByCaller = false;
  private connectPromise: Promise<EditorPrincipal> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  private readonly connectionListeners = new Set<(connected: boolean) => void>();

  constructor(private readonly options: AveClientOptions) {}

  get currentPrincipal(): EditorPrincipal | null {
    return this.principal;
  }

  get connected(): boolean {
    return this.ws?.readyState === WS_OPEN && this.principal !== null;
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  async connect(): Promise<EditorPrincipal> {
    if (this.connected && this.principal) return this.principal;
    if (this.connectPromise) return this.connectPromise;
    this.closedByCaller = false;
    this.connectPromise = this.openSocket().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new EditorError("CANCELLED", "Client closed"));
      this.pending.delete(id);
    }
    const socket = this.ws;
    this.ws = null;
    this.principal = null;
    socket?.close(1000, "client close");
    for (const listener of this.connectionListeners) listener(false);
  }

  async call<TOutput = unknown>(method: string, input: unknown = {}): Promise<TOutput> {
    await this.connect();
    return this.sendRequest<TOutput>({ method, input }, false);
  }

  async callBinary(method: string, inputOrFrame: unknown): Promise<Uint8Array> {
    await this.connect();
    if (inputOrFrame instanceof Uint8Array) {
      return this.sendBinaryFrame(method, inputOrFrame);
    }
    return this.sendRequest<Uint8Array>({ method, input: inputOrFrame }, true);
  }

  async subscribe(
    projectId: string,
    afterSeq: string,
    onEvent: (event: EditorEvent) => void,
  ): Promise<() => void> {
    await this.connect();
    let entry = this.subscriptions.get(projectId);
    if (!entry) {
      entry = { projectId, lastSeq: afterSeq, listeners: new Set() };
      this.subscriptions.set(projectId, entry);
      this.sendJson({ kind: "subscribe", projectId, afterSeq });
    } else if (BigInt(afterSeq) < BigInt(entry.lastSeq)) {
      entry.lastSeq = afterSeq;
    }
    entry.listeners.add(onEvent);

    // Catch up missed events immediately on initial subscribe
    await this.catchUpSubscription(entry);

    return () => {
      const current = this.subscriptions.get(projectId);
      if (!current) return;
      current.listeners.delete(onEvent);
      if (current.listeners.size === 0) {
        this.subscriptions.delete(projectId);
        if (this.ws?.readyState === WS_OPEN) {
          this.sendJson({ kind: "unsubscribe", projectId });
        }
      }
    };
  }

  reconcileMutation(projectId: string, requestId: string) {
    return this.call<z.infer<typeof GetMutationResultResultSchema>>(
      "video.v1.get_mutation_result",
      { projectId, requestId },
    );
  }

  getCapabilities() {
    return this.call<CapabilitySet>("video.v1.get_capabilities", {});
  }

  listProjects() {
    return this.call<{ projects: Array<{ projectId: string; title: string; revision: string }> }>(
      "video.v1.list_projects",
      {},
    );
  }

  createProject(input: z.infer<typeof CreateProjectInputSchema>) {
    return this.call<ProjectSnapshot>("video.v1.create_project", input);
  }

  getProject(projectId: string) {
    return this.call<ProjectSnapshot>("video.v1.get_project", { projectId });
  }

  submitPlan(input: z.infer<typeof PlanReviewRequestSchema>) {
    return this.call<z.infer<typeof PlanReviewResultSchema>>("video.v1.submit_plan", input);
  }

  decideApproval(input: ApprovalDecision) {
    return this.call<z.infer<typeof DecideApprovalResultSchema>>("video.v1.decide_approval", input);
  }

  revokeApproval(input: RevokeApprovalRequest) {
    return this.call<ApprovalRequest>("video.v1.revoke_approval", input);
  }

  createJob(input: z.infer<typeof CreateJobRequestSchema>) {
    return this.call<{ job: JobSnapshot; deduplicated: boolean }>("video.v1.create_job", input);
  }

  getJob(projectId: string, jobId: string) {
    return this.call<JobSnapshot>("video.v1.get_job", { projectId, jobId });
  }

  controlJob(input: z.infer<typeof JobControlRequestSchema>) {
    return this.call<JobSnapshot>("video.v1.control_job", input);
  }

  getEvents(projectId: string, afterSeq: string) {
    return this.call<z.infer<typeof EventsResultSchema>>("video.v1.get_events", {
      projectId,
      afterSeq,
    });
  }

  verifyExport(requestId: string, projectId: string, jobId: string) {
    return this.call<VerifyExportResult>("video.v1.verify_export", {
      requestId,
      projectId,
      jobId,
    });
  }

  private async openSocket(): Promise<EditorPrincipal> {
    const Ctor =
      this.options.WebSocketImpl ??
      (globalThis.WebSocket as unknown as WebSocketConstructor | undefined);
    if (!Ctor) {
      throw new EditorError("UPSTREAM_UNAVAILABLE", "No WebSocket implementation available");
    }

    return new Promise<EditorPrincipal>((resolve, reject) => {
      const ws = new Ctor(this.options.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let settled = false;

      const onOpen = () => {
        this.sendJson({
          kind: "hello",
          protocolVersion: AVE_WS_PROTOCOL_VERSION,
          auth: this.options.auth,
        });
      };

      const onMessage = async (rawEvent: unknown) => {
        const raw =
          rawEvent && typeof rawEvent === "object" && "data" in rawEvent
            ? (rawEvent as { data: unknown }).data
            : rawEvent;
        const { text, bytes } = await rawMessageToTextOrBytes(raw);
        if (bytes) {
          // Handle binary response frame
          try {
            const frame = decodeWsBinaryFrame(bytes);
            const entry = this.pending.get(frame.correlationId);
            if (entry) {
              clearTimeout(entry.timer);
              this.pending.delete(frame.correlationId);
              entry.resolve(frame.payload);
            }
          } catch {
            // Ignore malformed binary frame
          }
          return;
        }
        if (!text) return;
        let parsed: WsServerMessage;
        try {
          parsed = WsServerMessageSchema.parse(JSON.parse(text));
        } catch {
          return;
        }
        switch (parsed.kind) {
          case "hello_ack": {
            this.principal = parsed.principal;
            this.reconnectAttempt = 0;
            for (const listener of this.connectionListeners) listener(true);
            if (!settled) {
              settled = true;
              resolve(parsed.principal);
            }
            for (const sub of this.subscriptions.values()) {
              this.sendJson({ kind: "subscribe", projectId: sub.projectId, afterSeq: sub.lastSeq });
              void this.catchUpSubscription(sub);
            }
            break;
          }
          case "response": {
            const entry = this.pending.get(parsed.id);
            if (!entry) break;
            clearTimeout(entry.timer);
            this.pending.delete(parsed.id);
            if (entry.binary) {
              if (parsed.binaryBase64 !== undefined) {
                entry.resolve(base64ToBytes(parsed.binaryBase64));
              } else if (parsed.result instanceof Uint8Array) {
                entry.resolve(parsed.result);
              } else {
                entry.reject(new EditorError("INTERNAL", "Expected binary response"));
              }
            } else {
              entry.resolve(parsed.result);
            }
            break;
          }
          case "error": {
            const err = new EditorError(
              parsed.error.code,
              parsed.error.sanitizedDetail,
              parsed.error.retryable,
            );
            if (parsed.id) {
              const entry = this.pending.get(parsed.id);
              if (entry) {
                clearTimeout(entry.timer);
                this.pending.delete(parsed.id);
                entry.reject(err);
              }
            } else if (!settled) {
              settled = true;
              reject(err);
            }
            break;
          }
          case "event": {
            this.dispatchEvent(parsed.event);
            break;
          }
        }
      };

      const onCloseOrError = () => {
        const wasConnected = this.principal !== null;
        this.ws = null;
        this.principal = null;
        if (wasConnected) {
          for (const listener of this.connectionListeners) listener(false);
        }
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new EditorError("UPSTREAM_UNAVAILABLE", "WebSocket connection closed", true));
          this.pending.delete(id);
        }
        if (!settled) {
          settled = true;
          reject(new EditorError("UPSTREAM_UNAVAILABLE", "Unable to connect to AVE daemon", true));
        }
        if (!this.closedByCaller && (this.options.reconnect ?? true)) {
          this.scheduleReconnect();
        }
      };

      if (typeof ws.addEventListener === "function") {
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", (ev) => void onMessage(ev));
        ws.addEventListener("close", onCloseOrError);
        ws.addEventListener("error", onCloseOrError);
      } else if (typeof ws.on === "function") {
        ws.on("open", onOpen);
        ws.on("message", (data) => void onMessage(data));
        ws.on("close", onCloseOrError);
        ws.on("error", onCloseOrError);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByCaller) return;
    const base = this.options.reconnectBaseMs ?? 150;
    const delay = Math.min(5000, base * 2 ** Math.min(this.reconnectAttempt, 5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByCaller) {
        void this.connect().catch(() => {});
      }
    }, delay);
  }

  private async catchUpSubscription(sub: SubscriptionEntry): Promise<void> {
    try {
      const res = await this.getEvents(sub.projectId, sub.lastSeq);
      for (const event of res.events) {
        this.dispatchEvent(event);
      }
    } catch {
      // Next reconnect or live push will retry
    }
  }

  private dispatchEvent(event: EditorEvent): void {
    const sub = this.subscriptions.get(event.projectId);
    if (!sub) return;
    if (BigInt(event.seq) <= BigInt(sub.lastSeq)) return;
    sub.lastSeq = event.seq;
    for (const listener of sub.listeners) {
      listener(event);
    }
  }

  private sendJson(message: WsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new EditorError("UPSTREAM_UNAVAILABLE", "WebSocket is not open", true);
    }
    this.ws.send(JSON.stringify(message));
  }

  private sendRequest<T>(
    req: { method: string; input?: unknown; binary?: Uint8Array },
    expectBinary: boolean,
  ): Promise<T> {
    const id = nextCorrelationId();
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EditorError("UPSTREAM_UNAVAILABLE", `RPC ${req.method} timed out`, true));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        binary: expectBinary,
      });
      try {
        this.sendJson({
          kind: "request",
          id,
          method: req.method,
          input: req.input,
          ...(req.binary ? { binaryBase64: bytesToBase64(req.binary) } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendBinaryFrame(method: string, framedChunk: Uint8Array): Promise<Uint8Array> {
    const id = nextCorrelationId();
    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    return new Promise<Uint8Array>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) {
        reject(new EditorError("UPSTREAM_UNAVAILABLE", "WebSocket is not open", true));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EditorError("UPSTREAM_UNAVAILABLE", `Binary RPC ${method} timed out`, true));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        binary: true,
      });
      try {
        this.ws.send(encodeWsBinaryFrame(id, method, framedChunk));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

export function decodeChunkResponse(frame: Uint8Array) {
  return decodeFramedChunk(frame);
}
