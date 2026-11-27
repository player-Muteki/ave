import { describe, expect, it } from "vitest";
import {
  WsClientMessageSchema,
  WsServerMessageSchema,
  base64ToBytes,
  bytesToBase64,
  decodeWsBinaryFrame,
  encodeWsBinaryFrame,
} from "../src/index.js";

describe("@ave/protocol", () => {
  it("validates WS client and server message envelopes", () => {
    expect(
      WsClientMessageSchema.safeParse({
        kind: "hello",
        protocolVersion: "1",
        auth: { kind: "localOwner", token: "secret-token" },
      }).success,
    ).toBe(true);

    expect(
      WsClientMessageSchema.safeParse({
        kind: "subscribe",
        projectId: "proj-1",
        afterSeq: "42",
      }).success,
    ).toBe(true);

    expect(
      WsServerMessageSchema.safeParse({
        kind: "hello_ack",
        protocolVersion: "1",
        principal: { principalId: "owner", role: "owner", projectIds: null },
        serverTime: "2026-11-27T12:00:00Z",
      }).success,
    ).toBe(true);

    expect(
      WsServerMessageSchema.safeParse({
        kind: "error",
        id: "req-1",
        ok: false,
        error: { code: "REVISION_CONFLICT", retryable: false, sanitizedDetail: "stale" },
      }).success,
    ).toBe(true);

    expect(
      WsClientMessageSchema.safeParse({
        kind: "hello",
        protocolVersion: "2",
        auth: { kind: "localOwner", token: "x" },
      }).success,
    ).toBe(false);
  });

  it("round-trips binary WS frames and base64 conversion", () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const frame = encodeWsBinaryFrame("corr-1", "video.v1.write_upload_chunk", payload);
    const decoded = decodeWsBinaryFrame(frame);
    expect(decoded.correlationId).toBe("corr-1");
    expect(decoded.method).toBe("video.v1.write_upload_chunk");
    expect(Array.from(decoded.payload)).toEqual([10, 20, 30, 40, 50]);
    expect(Array.from(base64ToBytes(bytesToBase64(payload)))).toEqual([10, 20, 30, 40, 50]);
    expect(() => decodeWsBinaryFrame(new Uint8Array([0, 5]))).toThrow();
  });
});
