import { describe, expect, it } from "vitest";
import {
  encodeFramedChunk,
  decodeFramedChunk,
  decodeChunkMetadata,
} from "../shared/bytes.js";

describe("framed chunk wire bytes", () => {
  it("round-trips metadata and payload, including an empty payload", () => {
    const payload = new Uint8Array([1, 2, 3, 250]);
    const frame = encodeFramedChunk({ offset: "0", sha256: "a".repeat(64) }, payload);
    const decoded = decodeFramedChunk(frame);
    expect(JSON.parse(new TextDecoder().decode(decoded.metadata))).toEqual({
      offset: "0",
      sha256: "a".repeat(64),
    });
    expect(decoded.payload).toEqual(payload);
    expect(decodeChunkMetadata(frame)).toEqual({ offset: "0", sha256: "a".repeat(64) });

    const empty = encodeFramedChunk({ offset: "0" }, new Uint8Array(0));
    expect(decodeFramedChunk(empty).payload.byteLength).toBe(0);
  });

  it("decodes correctly from a view with a non-zero byteOffset", () => {
    const frame = encodeFramedChunk({ offset: "262144" }, new Uint8Array([9, 8, 7]));
    const padded = new Uint8Array(frame.byteLength + 5);
    padded.set(frame, 5);
    const view = padded.subarray(5);
    expect(decodeChunkMetadata(view)).toEqual({ offset: "262144" });
    expect(decodeFramedChunk(view).payload).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("rejects incomplete frames and headers", () => {
    expect(() => decodeFramedChunk(new Uint8Array(0))).toThrow("incomplete");
    expect(() => decodeFramedChunk(new Uint8Array(1))).toThrow("incomplete");
    // Declared header length larger than the bytes that follow.
    const bad = new Uint8Array(4);
    new DataView(bad.buffer).setUint16(0, 100);
    expect(() => decodeFramedChunk(bad)).toThrow("header is incomplete");
  });

  it("rejects non-object metadata", () => {
    for (const value of ["[]", "null", "42", '"text"']) {
      const header = new TextEncoder().encode(value);
      const frame = new Uint8Array(2 + header.byteLength);
      new DataView(frame.buffer).setUint16(0, header.byteLength);
      frame.set(header, 2);
      expect(() => decodeFramedChunk(frame)).toThrow("must be an object");
    }
  });

  it("rejects metadata larger than the 16-bit length prefix", () => {
    const big = { blob: "x".repeat(70_000) };
    expect(() => encodeFramedChunk(big, new Uint8Array(0))).toThrow("too large");
  });
});