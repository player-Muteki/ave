import { describe, expect, it } from "vitest";
import { MAX_DESK_SOURCE_BYTES, SourceImport, type DeskSource } from "../client/import-source.js";
import { decodeChunkMetadata } from "../shared/bytes.js";

// SourceImport is the pure desk/web source-upload state machine (hash is injected,
// no expo-crypto / react-native dependency). These tests drive it with mock upload
// channels to pin the size gate, chunk loop, ack/commit verification and replay
// idempotency that the shared desktop source import relies on.

const DIGEST = "a".repeat(64);
const hash = async (_bytes: ArrayBuffer) => DIGEST;

function makeFile(size: number, type = "video/mp4"): DeskSource {
  const data = new Uint8Array(size).fill(65);
  return {
    name: "clip.mp4",
    size,
    type,
    slice(start = 0, end = size) {
      const part = data.slice(start, end);
      return { arrayBuffer: async () => part.buffer };
    },
  };
}

const stub = (size: number): DeskSource => ({
  name: "c", size, type: "video/mp4",
  slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
});

interface RpcOpts {
  chunkSize?: string;
  nextOffset?: string;
  statusUploadId?: string;
  ackOffset?: (end: number) => string;
  commitSha?: string;
  commitBytes?: string;
}

function makeRpc(size: number, opts: RpcOpts = {}) {
  const calls = { declare: 0, status: 0, write: 0, commit: 0 };
  const chunkSize = opts.chunkSize ?? "4";
  return {
    calls,
    async declare(_input: unknown) {
      calls.declare++;
      return { uploadId: "u", chunkSize, nextOffset: "0" };
    },
    async status(_input: unknown) {
      calls.status++;
      return { uploadId: opts.statusUploadId ?? "u", chunkSize, nextOffset: opts.nextOffset ?? "0" };
    },
    async write(frame: Uint8Array) {
      calls.write++;
      const meta = decodeChunkMetadata(frame);
      const end = Number(meta.offset) + Number(meta.length);
      const ackOffset = opts.ackOffset ? opts.ackOffset(end) : String(end);
      return new TextEncoder().encode(JSON.stringify({ uploadId: "u", nextOffset: ackOffset }));
    },
    async commit(_input: unknown) {
      calls.commit++;
      return { original: { sha256: opts.commitSha ?? DIGEST, bytes: opts.commitBytes ?? String(size) } };
    },
  };
}

describe("SourceImport size gate", () => {
  it("rejects empty, negative, fractional and oversized sources", () => {
    expect(() => new SourceImport("p", stub(0), "r")).toThrow(/非空且不超过 64 MiB/);
    expect(() => new SourceImport("p", stub(-1), "r")).toThrow(/非空且不超过 64 MiB/);
    expect(() => new SourceImport("p", stub(1.5), "r")).toThrow(/非空且不超过 64 MiB/);
    expect(() => new SourceImport("p", stub(MAX_DESK_SOURCE_BYTES + 1), "r")).toThrow(/非空且不超过 64 MiB/);
  });

  it("accepts a one-byte and the maximum-size source", () => {
    expect(() => new SourceImport("p", stub(1), "r")).not.toThrow();
    expect(() => new SourceImport("p", stub(MAX_DESK_SOURCE_BYTES), "r")).not.toThrow();
  });
});

describe("SourceImport transfer happy path", () => {
  it("chunks, confirms and commits a 10-byte source with 4-byte chunks", async () => {
    const rpc = makeRpc(10);
    const progress: number[] = [];
    const importer = new SourceImport("p", makeFile(10), "r");
    const asset = await importer.transfer(rpc as never, hash, (n) => progress.push(n));
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(rpc.calls).toEqual({ declare: 1, status: 1, write: 3, commit: 1 });
    expect(asset.original).toEqual({ sha256: DIGEST, bytes: "10" });
  });

  it("falls back to application/octet-stream when the file type is empty", async () => {
    let declared: Record<string, unknown> | undefined;
    const rpc = makeRpc(4);
    const originalDeclare = rpc.declare.bind(rpc);
    rpc.declare = async (input: unknown) => {
      declared = input as Record<string, unknown>;
      return originalDeclare(input);
    };
    const importer = new SourceImport("p", makeFile(4, ""), "r");
    await importer.transfer(rpc as never, hash, () => {});
    expect(declared?.mediaType).toBe("application/octet-stream");
  });
});

describe("SourceImport transfer fail-closed", () => {
  it("rejects an invalid status (chunkSize / offset / uploadId)", async () => {
    const importer = () => new SourceImport("p", makeFile(10), "r");
    await expect(importer().transfer(makeRpc(10, { chunkSize: "0" }) as never, hash, () => {}))
      .rejects.toThrow(/上传进度无效/);
    await expect(importer().transfer(makeRpc(10, { chunkSize: "262145" }) as never, hash, () => {}))
      .rejects.toThrow(/上传进度无效/);
    await expect(importer().transfer(makeRpc(10, { nextOffset: "11" }) as never, hash, () => {}))
      .rejects.toThrow(/上传进度无效/);
    await expect(importer().transfer(makeRpc(10, { statusUploadId: "other" }) as never, hash, () => {}))
      .rejects.toThrow(/上传进度无效/);
  });

  it("rejects a chunk ack whose nextOffset does not match the sent bytes", async () => {
    const rpc = makeRpc(10, { ackOffset: (end) => String(end + 1) });
    await expect(new SourceImport("p", makeFile(10), "r").transfer(rpc as never, hash, () => {}))
      .rejects.toThrow(/分块确认与发送内容不符/);
  });

  it("rejects a source whose slice length changed mid-transfer", async () => {
    const shrinking: DeskSource = {
      name: "clip.mp4", size: 10, type: "video/mp4",
      slice: () => ({ arrayBuffer: async () => new Uint8Array(1).buffer }),
    };
    await expect(new SourceImport("p", shrinking, "r").transfer(makeRpc(10) as never, hash, () => {}))
      .rejects.toThrow(/所选文件长度已变化/);
  });

  it("rejects a commit receipt whose hash or byte count differs", async () => {
    await expect(new SourceImport("p", makeFile(10), "r").transfer(makeRpc(10, { commitSha: "b".repeat(64) }) as never, hash, () => {}))
      .rejects.toThrow(/素材回执与所选文件不符/);
    await expect(new SourceImport("p", makeFile(10), "r").transfer(makeRpc(10, { commitBytes: "9" }) as never, hash, () => {}))
      .rejects.toThrow(/素材回执与所选文件不符/);
  });
});

describe("SourceImport replay idempotency", () => {
  it("a second transfer reuses the upload and skips straight to commit", async () => {
    const rpc = makeRpc(10);
    const importer = new SourceImport("p", makeFile(10), "r");
    await importer.transfer(rpc as never, hash, () => {});
    await importer.transfer(rpc as never, hash, () => {});
    expect(rpc.calls).toEqual({ declare: 1, status: 1, write: 3, commit: 2 });
  });
});