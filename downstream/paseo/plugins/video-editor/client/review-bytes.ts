import { ReadAssetChunkMetadataSchema, type ReadAssetChunkRequest, type BlobRef } from "../shared/contracts/v1.js";
import { decodeFramedChunk } from "../shared/bytes.js";

interface ReviewRead {
  projectId: string;
  assetId: string;
  revision: string;
  blob: BlobRef;
}

/** Verify the selected revision and its bytes before handing anything to a decoder. */
export async function readReviewBytes(
  selected: ReviewRead,
  read: (input: ReadAssetChunkRequest) => Promise<Uint8Array>,
  hash: (input: ArrayBuffer) => Promise<string>,
  signal: AbortSignal,
  purpose: "play" | "export" | "manifest" | "qa" = "play",
): Promise<ArrayBuffer> {
  const { blob, projectId, assetId, revision } = selected;
  const size = BigInt(blob.bytes);
  const expectedType = purpose === "manifest" || purpose === "qa" ? "application/json" : "video/mp4";
  if (purpose !== "play" && !assetId.endsWith(`:${purpose}`))
    throw new Error("此文件不是已交付的成品或清单。");
  if (blob.mediaType !== expectedType || size < 1n || size > 64n * 1024n * 1024n)
    throw new Error("文件格式不匹配或超过工作台的 64 MiB 限制。");
  const output = new Uint8Array(Number(size));
  for (let offset = 0; offset < output.length;) {
    signal.throwIfAborted();
    const length = Math.min(262144, output.length - offset);
    const frame = await read({projectId, assetId, revision, offset: String(offset), length: String(length)});
    signal.throwIfAborted();
    const {metadata, payload} = decodeFramedChunk(frame);
    const header = ReadAssetChunkMetadataSchema.parse(JSON.parse(new TextDecoder().decode(metadata)));
    if (header.assetSha256 !== blob.sha256 || header.totalBytes !== blob.bytes || header.revision !== revision || header.offset !== String(offset) || header.bytesLength !== String(length) || payload.length !== length || await hash(new Uint8Array(payload).buffer) !== header.chunkSha256)
      throw new Error("文件分块与所选版本不符，请刷新项目后重试。");
    output.set(payload, offset);
    offset += length;
  }
  signal.throwIfAborted();
  if (await hash(output.buffer) !== blob.sha256) throw new Error("文件校验失败，请重新读取。");
  return output.buffer;
}
