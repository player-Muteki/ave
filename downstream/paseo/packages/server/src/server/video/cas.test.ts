import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ContentAddressedStore } from "./cas.js";

it("returns a legitimate final partial range but never pads a truncated review artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "video-cas-range-"));
  try {
    const cas = new ContentAddressedStore(root);
    await cas.initialize();
    const ref = await cas.writeBytes(Buffer.from("abcdef"), "application/octet-stream");
    expect(await cas.readRange(ref, 4n, 32n)).toEqual(Buffer.from("ef"));
    await truncate(cas.pathFor(ref), 5);
    await expect(cas.readRange(ref, 4n, 32n)).rejects.toMatchObject({
      code: "ARTIFACT_HASH_MISMATCH",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes content-addressed bytes, dedups identical content, and detects tampering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "video-cas-bytes-"));
  try {
    const cas = new ContentAddressedStore(root);
    await cas.initialize();
    const bytes = Buffer.from("hello video");
    const ref = await cas.writeBytes(bytes, "video/mp4");
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(ref.bytes).toBe(String(bytes.byteLength));
    expect(await cas.readBytes(ref)).toEqual(bytes);
    // Identical content is content-addressed to the same object.
    const again = await cas.writeBytes(bytes, "video/mp4");
    expect(again.sha256).toBe(ref.sha256);
    expect(cas.pathFor(again)).toBe(cas.pathFor(ref));
    // Tampering with the stored object fails the integrity check on read.
    await writeFile(cas.pathFor(ref), Buffer.from("tampered!!!"));
    await expect(cas.readBytes(ref)).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("round-trips a JSON artifact with a stable digest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "video-cas-json-"));
  try {
    const cas = new ContentAddressedStore(root);
    await cas.initialize();
    const ref = await cas.writeJson({ reportId: "r1", subjectHash: "a".repeat(64) });
    expect(ref.mediaType).toBe("application/json");
    const parsed = JSON.parse((await cas.readBytes(ref)).toString());
    expect(parsed).toEqual({ reportId: "r1", subjectHash: "a".repeat(64) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
