import {
  ReadAssetChunkMetadataSchema,
  SourceAssetSchema,
  UploadStatusSchema,
  decodeFramedChunk,
  encodeFramedChunk,
  type SourceAsset,
  type cancelUploadRpc,
  type commitUploadRpc,
  type createUploadRpc,
  type getMutationResultRpc,
  type getUploadStatusRpc,
} from "@ave/contracts";
import type { z } from "zod";
import type { AveClient } from "./client.js";

export const MAX_DESK_SOURCE_BYTES = 64 * 1024 * 1024;
const ackSchema = UploadStatusSchema.pick({ uploadId: true, nextOffset: true });
type Status = z.infer<typeof UploadStatusSchema>;

export interface UploadChannels {
  declare(input: z.infer<typeof createUploadRpc.input>): Promise<Status>;
  status(input: z.infer<typeof getUploadStatusRpc.input>): Promise<Status>;
  write(frame: Uint8Array): Promise<Uint8Array>;
  commit(input: z.infer<typeof commitUploadRpc.input>): Promise<SourceAsset>;
  cancel(
    input: z.infer<typeof cancelUploadRpc.input>,
  ): Promise<z.infer<typeof cancelUploadRpc.output>>;
}

export interface DeskSource {
  name: string;
  size: number;
  type: string;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export async function sha256HexBrowserSafe(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createUploadChannels(client: AveClient): UploadChannels & {
  lookup(
    input: z.infer<typeof getMutationResultRpc.input>,
  ): Promise<z.infer<typeof getMutationResultRpc.output>>;
} {
  return {
    declare: (input) => client.call("video.v1.create_upload", input),
    status: (input) => client.call("video.v1.get_upload_status", input),
    write: (frame) => client.callBinary("video.v1.write_upload_chunk", frame),
    commit: (input) => client.call("video.v1.commit_upload", input),
    cancel: (input) => client.call("video.v1.cancel_upload", input),
    lookup: (input) => client.reconcileMutation(input.projectId, input.requestId),
  };
}

export class SourceImport {
  private digest?: string;
  private uploadId?: string;
  private declarationSent = false;
  private readyToCommit = false;

  constructor(
    readonly projectId: string,
    readonly file: DeskSource,
    private readonly requestId: string,
  ) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_DESK_SOURCE_BYTES) {
      throw new Error("请选择非空且不超过 64 MiB 的视频。");
    }
  }

  private async declare(rpc: Pick<UploadChannels, "declare">) {
    const { projectId, file, requestId, digest } = this;
    if (!digest) throw new Error("缺少素材摘要。");
    this.declarationSent = true;
    const created = await rpc.declare({
      projectId,
      requestId,
      expectedSize: String(file.size),
      expectedSha256: digest,
      displayName: file.name,
      mediaType: file.type || "application/octet-stream",
    });
    return created.uploadId;
  }

  async transfer(
    rpc: UploadChannels,
    hash: (bytes: ArrayBuffer) => Promise<string> = sha256HexBrowserSafe,
    progress: (confirmed: number) => void = () => {},
    signal?: AbortSignal,
  ): Promise<SourceAsset> {
    const { projectId, file, requestId } = this;
    this.digest ??= await hash(await file.slice().arrayBuffer());
    signal?.throwIfAborted();
    this.uploadId ??= await this.declare(rpc);
    signal?.throwIfAborted();
    const uploadId = this.uploadId;
    if (!this.readyToCommit) {
      const status = await rpc.status({ projectId, uploadId });
      const chunkSize = Number(status.chunkSize);
      let offset = Number(status.nextOffset);
      if (
        status.uploadId !== uploadId ||
        !Number.isSafeInteger(chunkSize) ||
        chunkSize < 1 ||
        chunkSize > 262144 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > file.size
      ) {
        throw new Error("上传进度无效，请重新选择素材。");
      }
      progress(offset);
      while (offset < file.size) {
        signal?.throwIfAborted();
        const end = Math.min(file.size, offset + chunkSize);
        const bytes = await file.slice(offset, end).arrayBuffer();
        if (bytes.byteLength !== end - offset) {
          throw new Error("所选文件长度已变化，请重新选择。");
        }
        const frame = encodeFramedChunk(
          {
            requestId: `${requestId}-${offset}`,
            uploadId,
            offset: String(offset),
            length: String(bytes.byteLength),
            chunkSha256: await hash(bytes),
          },
          new Uint8Array(bytes),
        );
        signal?.throwIfAborted();
        const ack = ackSchema.parse(JSON.parse(new TextDecoder().decode(await rpc.write(frame))));
        if (ack.uploadId !== uploadId || ack.nextOffset !== String(end)) {
          throw new Error("分块确认与发送内容不符，未提交素材。");
        }
        offset = end;
        progress(offset);
      }
      signal?.throwIfAborted();
      this.readyToCommit = true;
    }
    const asset = await rpc.commit({
      uploadId,
      requestId: `${requestId}-commit`,
      finalSha256: this.digest,
    });
    return this.verifyReceipt(asset);
  }

  private verifyReceipt(asset: SourceAsset) {
    if (asset.original.sha256 !== this.digest || asset.original.bytes !== String(this.file.size)) {
      throw new Error("素材回执与所选文件不符。");
    }
    return asset;
  }

  async cancel(
    rpc: Pick<UploadChannels, "declare" | "cancel"> & {
      lookup(
        input: z.infer<typeof getMutationResultRpc.input>,
      ): Promise<z.infer<typeof getMutationResultRpc.output>>;
    },
  ) {
    if (!this.declarationSent) return;
    this.uploadId ??= await this.declare(rpc);
    try {
      await rpc.cancel({
        requestId: `${this.requestId}-cancel`,
        projectId: this.projectId,
        uploadId: this.uploadId,
      });
    } catch (error) {
      if (this.readyToCommit) {
        const { mutation } = await rpc.lookup({
          projectId: this.projectId,
          requestId: `${this.requestId}-commit`,
        });
        if (mutation) return this.verifyReceipt(SourceAssetSchema.parse(mutation.response));
      }
      throw error;
    }
    this.uploadId = undefined;
    this.declarationSent = false;
    this.readyToCommit = false;
  }
}

export async function downloadArtifactBytes(
  client: AveClient,
  input: { projectId: string; assetId: string; revision: string; chunkSize?: number; signal?: AbortSignal },
  hashFn: (bytes: Uint8Array) => Promise<string> = sha256HexBrowserSafe,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const chunkSize = input.chunkSize ?? 262_144;
  let offset = 0n;
  let totalBytes: bigint | undefined;
  let expectedAssetSha: string | undefined;
  const parts: Uint8Array[] = [];

  while (totalBytes === undefined || offset < totalBytes) {
    input.signal?.throwIfAborted();
    const frame = await client.callBinary("video.v1.read_asset_chunk", {
      projectId: input.projectId,
      assetId: input.assetId,
      revision: input.revision,
      offset: offset.toString(),
      length: String(chunkSize),
    });
    const decoded = decodeFramedChunk(frame);
    input.signal?.throwIfAborted();
    const meta = ReadAssetChunkMetadataSchema.parse(
      JSON.parse(new TextDecoder().decode(decoded.metadata)),
    );
    if (decoded.payload.byteLength.toString() !== meta.bytesLength) {
      throw new Error("Downloaded chunk length mismatch");
    }
    const actualChunkSha = await hashFn(decoded.payload);
    if (actualChunkSha !== meta.chunkSha256) {
      throw new Error("Downloaded chunk SHA-256 mismatch");
    }
    expectedAssetSha ??= meta.assetSha256;
    if (expectedAssetSha !== meta.assetSha256) {
      throw new Error("Downloaded asset SHA-256 changed mid-stream");
    }
    totalBytes ??= BigInt(meta.totalBytes);
    parts.push(decoded.payload);
    offset += BigInt(decoded.payload.byteLength);
  }

  const totalLen = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const full = new Uint8Array(totalLen);
  let cursor = 0;
  for (const part of parts) {
    full.set(part, cursor);
    cursor += part.byteLength;
  }
  const actualSha = await hashFn(full);
  if (expectedAssetSha && actualSha !== expectedAssetSha) {
    throw new Error("Downloaded full artifact SHA-256 mismatch");
  }
  return { bytes: full, sha256: actualSha };
}
