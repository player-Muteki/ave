import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedStore, sha256Bytes } from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ave-cas-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("@ave/cas", () => {
  it("commits chunked uploads, verifies hashes, and reads bounded ranges", async () => {
    const dir = await makeTempDir();
    const cas = new ContentAddressedStore(path.join(dir, "cas"));
    await cas.initialize();

    const part1 = Buffer.from("hello ");
    const part2 = Buffer.from("ave-cas!");
    const full = Buffer.concat([part1, part2]);
    const digest = sha256Bytes(full);

    await cas.writeUploadChunk("up-1", 0n, part1);
    await cas.writeUploadChunk("up-1", BigInt(part1.length), part2);
    const ref = await cas.commitUpload("up-1", digest, String(full.length), "application/octet-stream");
    expect(ref).toEqual({ sha256: digest, bytes: String(full.length), mediaType: "application/octet-stream" });
    expect(await cas.has(ref)).toBe(true);
    expect(await cas.verifyBlob(ref)).toBe(true);

    const slice = await cas.readChunk(ref, 6n, 100n);
    expect(slice.toString("utf8")).toBe("ave-cas!");
    await expect(cas.readChunk(ref, BigInt(full.length), 1n)).rejects.toThrow();

    await cas.removeTemporaryUpload("up-1");
  });

  it("rejects upload size/hash mismatches and detects tampered blobs", async () => {
    const dir = await makeTempDir();
    const cas = new ContentAddressedStore(path.join(dir, "cas"));
    await cas.initialize();

    const data = Buffer.from("immutable-bytes");
    await cas.writeUploadChunk("up-bad", 0n, data);
    await expect(
      cas.commitUpload("up-bad", "0".repeat(64), String(data.length), "video/mp4"),
    ).rejects.toThrow(/hash/i);
    await expect(
      cas.commitUpload("up-bad", sha256Bytes(data), "999", "video/mp4"),
    ).rejects.toThrow(/byte count/i);

    const ref = await cas.putBytes(data, "text/plain");
    const ref2 = await cas.putBytes(data, "text/plain");
    expect(ref2).toEqual(ref);

    // Tamper blob directly on disk and assert verifyBlob & readBytes fail
    await writeFile(cas.pathFor(ref), Buffer.from("corrupted-bytes"));
    expect(await cas.verifyBlob(ref)).toBe(false);
    await expect(cas.readBytes(ref)).rejects.toThrow(/integrity/i);
  });
});
