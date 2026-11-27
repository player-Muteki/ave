import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  describeEditorError,
  editorFailure,
  type EditorPrincipal,
} from "@ave/contracts";
import {
  AVE_WS_PROTOCOL_VERSION,
  WsClientMessageSchema,
  base64ToBytes,
  bytesToBase64,
  decodeWsBinaryFrame,
  encodeWsBinaryFrame,
  type WsAuth,
  type WsServerMessage,
} from "@ave/protocol";
import type { AveStore } from "@ave/sqlite";
import type { AveRpcRegistry } from "./rpc-registry.js";

interface ClientConnection {
  ws: WebSocket;
  principal: EditorPrincipal | null;
  deviceId: string | null;
  subscriptions: Map<string, bigint>;
}

function sameToken(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export class AveWsServer {
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<ClientConnection>();
  private unsubscribeRevoke?: () => void;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      ownerToken: string;
      store: AveStore;
      rpc: AveRpcRegistry;
    },
  ) {}

  async start(): Promise<{ host: string; port: number; wsUrl: string; healthUrl: string }> {
    this.unsubscribeRevoke = this.options.store.devices.onRevoke((deviceId) => {
      for (const client of this.clients) {
        if (client.deviceId === deviceId) {
          this.sendJson(client.ws, {
            kind: "error",
            ok: false,
            error: {
              code: "UNAUTHENTICATED",
              retryable: false,
              sanitizedDetail: "Device access was revoked",
            },
          });
          client.ws.close(4001, "device revoked");
        }
      }
    });

    this.httpServer = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, protocolVersion: AVE_WS_PROTOCOL_VERSION }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws", maxPayload: 1024 * 1024 });
    this.wss.on("connection", (ws) => this.handleConnection(ws));

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.options.port, this.options.host, () => resolve());
    });
    const addr = this.httpServer.address() as AddressInfo;
    return {
      host: this.options.host,
      port: addr.port,
      wsUrl: `ws://${this.options.host}:${addr.port}/ws`,
      healthUrl: `http://${this.options.host}:${addr.port}/health`,
    };
  }

  async stop(): Promise<void> {
    this.unsubscribeRevoke?.();
    for (const client of this.clients) {
      client.ws.close(1001, "daemon stopping");
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.wss = null;
    this.httpServer = null;
  }

  notifyProjectEvents(projectId: string): void {
    for (const client of this.clients) {
      if (!client.principal) continue;
      const lastSeq = client.subscriptions.get(projectId);
      if (lastSeq === undefined) continue;
      try {
        const res = this.options.store.jobs.getEvents(
          projectId,
          lastSeq.toString(),
          client.principal,
        );
        for (const event of res.events) {
          const seq = BigInt(event.seq);
          if (seq > lastSeq) {
            client.subscriptions.set(projectId, seq);
            this.sendJson(client.ws, { kind: "event", event });
          }
        }
      } catch {
        // Subscription loses access or project missing; ignore silently
      }
    }
  }

  private handleConnection(ws: WebSocket): void {
    const conn: ClientConnection = {
      ws,
      principal: null,
      deviceId: null,
      subscriptions: new Map(),
    };
    this.clients.add(conn);

    ws.on("close", () => {
      this.clients.delete(conn);
    });

    ws.on("message", (data, isBinary) => {
      void this.onMessage(conn, data, isBinary);
    });
  }

  private async onMessage(conn: ClientConnection, data: unknown, isBinary: boolean): Promise<void> {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);
      let correlationId = "";
      let method = "";
      let payload: Uint8Array;
      try {
        const decoded = decodeWsBinaryFrame(buf);
        correlationId = decoded.correlationId;
        method = decoded.method;
        payload = decoded.payload;
      } catch {
        return;
      }
      if (!conn.principal) {
        this.sendJson(conn.ws, {
          kind: "error",
          id: correlationId,
          ok: false,
          error: {
            code: "UNAUTHENTICATED",
            retryable: false,
            sanitizedDetail: "Authenticate via hello before sending requests",
          },
        });
        return;
      }
      try {
        const principal = this.refreshPrincipal(conn);
        const result = await this.options.rpc.invoke(method, payload, {
          principalId: principal.principalId,
          editorPrincipal: principal,
          isLocalOwner: principal.role === "owner",
        });
        if (!(result instanceof Uint8Array)) {
          editorFailure("INTERNAL", "Binary request returned non-binary output");
        }
        conn.ws.send(encodeWsBinaryFrame(correlationId, method, result));
      } catch (error) {
        this.sendJson(conn.ws, {
          kind: "error",
          id: correlationId,
          ok: false,
          error: describeEditorError(error),
        });
      }
      return;
    }

    let rawText = "";
    if (typeof data === "string") rawText = data;
    else if (Buffer.isBuffer(data)) rawText = data.toString("utf8");
    else rawText = String(data);

    let msg;
    try {
      msg = WsClientMessageSchema.parse(JSON.parse(rawText));
    } catch {
      this.sendJson(conn.ws, {
        kind: "error",
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          retryable: false,
          sanitizedDetail: "Malformed WebSocket message envelope",
        },
      });
      return;
    }

    if (msg.kind === "hello") {
      try {
        const authed = this.authenticate(msg.auth);
        conn.principal = authed.principal;
        conn.deviceId = authed.deviceId;
        this.sendJson(conn.ws, {
          kind: "hello_ack",
          protocolVersion: AVE_WS_PROTOCOL_VERSION,
          principal: authed.principal,
          serverTime: new Date().toISOString(),
        });
      } catch (error) {
        this.sendJson(conn.ws, {
          kind: "error",
          ok: false,
          error: describeEditorError(error),
        });
        conn.ws.close(4001, "authentication failed");
      }
      return;
    }

    if (!conn.principal) {
      this.sendJson(conn.ws, {
        kind: "error",
        id: msg.kind === "request" ? msg.id : undefined,
        ok: false,
        error: {
          code: "UNAUTHENTICATED",
          retryable: false,
          sanitizedDetail: "Send hello before subscribing or invoking RPCs",
        },
      });
      return;
    }

    if (msg.kind === "subscribe") {
      conn.subscriptions.set(msg.projectId, BigInt(msg.afterSeq ?? "0"));
      this.notifyProjectEvents(msg.projectId);
      return;
    }

    if (msg.kind === "unsubscribe") {
      conn.subscriptions.delete(msg.projectId);
      return;
    }

    // msg.kind === "request"
    try {
      const principal = this.refreshPrincipal(conn);
      const rpcInput =
        msg.binaryBase64 !== undefined ? base64ToBytes(msg.binaryBase64) : (msg.input ?? {});
      const result = await this.options.rpc.invoke(msg.method, rpcInput, {
        principalId: principal.principalId,
        editorPrincipal: principal,
        isLocalOwner: principal.role === "owner",
      });
      if (result instanceof Uint8Array) {
        this.sendJson(conn.ws, {
          kind: "response",
          id: msg.id,
          ok: true,
          binaryBase64: bytesToBase64(result),
        });
      } else {
        this.sendJson(conn.ws, {
          kind: "response",
          id: msg.id,
          ok: true,
          result,
        });
      }
    } catch (error) {
      this.sendJson(conn.ws, {
        kind: "error",
        id: msg.id,
        ok: false,
        error: describeEditorError(error),
      });
    }
  }

  private authenticate(auth: WsAuth): { principal: EditorPrincipal; deviceId: string | null } {
    if (auth.kind === "localOwner") {
      if (!sameToken(this.options.ownerToken, auth.token)) {
        editorFailure("UNAUTHENTICATED", "Invalid local owner token");
      }
      return {
        principal: { principalId: "owner", role: "owner", projectIds: null },
        deviceId: null,
      };
    }
    const principal = this.options.store.devices.authenticate(auth.deviceId, auth.credential);
    return { principal, deviceId: auth.deviceId };
  }

  private refreshPrincipal(conn: ClientConnection): EditorPrincipal {
    if (conn.deviceId) {
      return this.options.store.devices.activePrincipal(conn.deviceId);
    }
    return conn.principal!;
  }

  private sendJson(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
