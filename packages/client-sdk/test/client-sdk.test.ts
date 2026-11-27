import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AveClient, SourceImport, sha256HexBrowserSafe } from "../src/index.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  while (servers.length) {
    const wss = servers.pop()!;
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

describe("@ave/client-sdk", () => {
  it("authenticates, reconnects, catches up events(afterSeq), and reconciles mutation results", async () => {
    const events = [
      {
        protocolVersion: "1",
        projectId: "p1",
        eventId: "e1",
        seq: "1",
        occurredAt: "2026-11-27T00:00:00Z",
        type: "project.created",
        payload: {},
      },
      {
        protocolVersion: "1",
        projectId: "p1",
        eventId: "e2",
        seq: "2",
        occurredAt: "2026-11-27T00:00:01Z",
        type: "job.state.changed",
        payload: { jobId: "j1", state: "completed" },
      },
    ];
    let dropNextRequest = true;

    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;

    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          kind: string;
          id?: string;
          method?: string;
          input?: { afterSeq?: string; requestId?: string };
        };
        if (msg.kind === "hello") {
          socket.send(
            JSON.stringify({
              kind: "hello_ack",
              protocolVersion: "1",
              principal: { principalId: "owner", role: "owner", projectIds: null },
              serverTime: "2026-11-27T00:00:00Z",
            }),
          );
          return;
        }
        if (msg.kind === "request") {
          if (msg.method === "video.v1.get_events") {
            const after = BigInt(msg.input?.afterSeq ?? "0");
            socket.send(
              JSON.stringify({
                kind: "response",
                id: msg.id,
                ok: true,
                result: {
                  events: events.filter((e) => BigInt(e.seq) > after),
                  snapshotRequired: false,
                },
              }),
            );
            return;
          }
          if (msg.method === "video.v1.submit_plan" && dropNextRequest) {
            dropNextRequest = false;
            socket.close(1012, "simulated crash");
            return;
          }
          if (msg.method === "video.v1.get_mutation_result") {
            socket.send(
              JSON.stringify({
                kind: "response",
                id: msg.id,
                ok: true,
                result: {
                  requestId: msg.input?.requestId,
                  projectId: "p1",
                  mutation: {
                    requestId: msg.input?.requestId,
                    projectId: "p1",
                    fingerprint: "a".repeat(64),
                    response: { restored: true },
                    createdAt: "2026-11-27T00:00:00Z",
                  },
                },
              }),
            );
            return;
          }
        }
      });
    });

    const client = new AveClient({
      url: `ws://127.0.0.1:${port}`,
      auth: { kind: "localOwner", token: "tok" },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: true,
      reconnectBaseMs: 30,
    });
    const received: string[] = [];
    const unsub = await client.subscribe("p1", "0", (ev) => received.push(ev.seq));
    await new Promise((r) => setTimeout(r, 40));
    expect(received).toEqual(["1", "2"]);

    // Trigger disconnect during submit_plan, then reconcile after auto-reconnect
    await expect(client.call("video.v1.submit_plan", {})).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    const reconciled = await client.reconcileMutation("p1", "req-lost-1");
    expect(reconciled.mutation?.response).toEqual({ restored: true });

    unsub();
    client.close();
  });

  it("uploads files in verified chunks via SourceImport", async () => {
    const payload = new Uint8Array(600_000);
    payload.fill(7);
    const digest = await sha256HexBrowserSafe(payload);
    let confirmedOffset = 0;

    const importer = new SourceImport(
      "proj-1",
      {
        name: "sample.mp4",
        size: payload.byteLength,
        type: "video/mp4",
        slice: (s = 0, e = payload.byteLength) => ({
          arrayBuffer: async () => payload.slice(s, e).buffer,
        }),
      },
      "req-upload-1",
    );

    const progressMarks: number[] = [];
    const asset = await importer.transfer(
      {
        declare: async () => ({ uploadId: "u-1", chunkSize: "262144", nextOffset: "0" }),
        status: async () => ({
          uploadId: "u-1",
          chunkSize: "262144",
          nextOffset: String(confirmedOffset),
        }),
        write: async (frame) => {
          const headerLen = new DataView(frame.buffer, frame.byteOffset).getUint16(0);
          const meta = JSON.parse(new TextDecoder().decode(frame.subarray(2, 2 + headerLen))) as {
            offset: string;
            length: string;
          };
          confirmedOffset = Number(meta.offset) + Number(meta.length);
          return new TextEncoder().encode(
            JSON.stringify({ uploadId: "u-1", nextOffset: String(confirmedOffset) }),
          );
        },
        commit: async () => ({
          assetId: "asset-u-1",
          original: { sha256: digest, bytes: String(payload.byteLength), mediaType: "video/mp4" },
          displayName: "sample.mp4",
          streams: [],
          presentationIndex: { sha256: digest, bytes: "10", mediaType: "application/json" },
          probe: { sha256: digest, bytes: "10", mediaType: "application/json" },
          sourceNeverWritable: true,
        }),
        cancel: async () => ({ requestId: "c", projectId: "proj-1", uploadId: "u-1", cancelled: true }),
      },
      sha256HexBrowserSafe,
      (n) => progressMarks.push(n),
    );

    expect(asset.assetId).toBe("asset-u-1");
    expect(progressMarks.at(-1)).toBe(payload.byteLength);
  });
});
