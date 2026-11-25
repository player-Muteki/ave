import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { readReviewBytes } from "../client/review-bytes.js";

// Complements review-bytes.test.ts: covers the abort-signal gate and the blob
// size bounds (empty / over 64 MiB) that guard the review/export byte reader.

const sum = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const hash = async (data: ArrayBuffer) => sum(new Uint8Array(data));
const payload = new Uint8Array(8).fill(71);
const selected = {
  projectId: "project", assetId: "job:candidate", revision: "7",
  blob: { sha256: sum(payload), bytes: String(payload.length), mediaType: "video/mp4" },
};
const read = async () => { throw new Error("read should not be reached"); };

it("rejects an already-aborted signal before reading", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(readReviewBytes(selected, read, hash, controller.signal)).rejects.toThrow(/aborted/i);
});

it("rejects an empty blob", async () => {
  const empty = { ...selected, blob: { ...selected.blob, bytes: "0", sha256: sum(new Uint8Array(0)) } };
  await expect(readReviewBytes(empty, read, hash, new AbortController().signal)).rejects.toThrow(/格式不匹配或超过/);
});

it("rejects a blob over the 64 MiB workbench limit before allocating", async () => {
  const huge = { ...selected, blob: { ...selected.blob, bytes: String(64 * 1024 * 1024 + 1) } };
  await expect(readReviewBytes(huge, read, hash, new AbortController().signal)).rejects.toThrow(/格式不匹配或超过/);
});