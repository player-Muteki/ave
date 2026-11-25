import { encodeFramedChunk } from "../shared/bytes.js";
import {
  UploadStatusSchema,
  SourceAssetSchema,
  type getMutationResultRpc,
  type createUploadRpc,
  type getUploadStatusRpc,
  type commitUploadRpc,
  type cancelUploadRpc,
  type SourceAsset,
} from "../shared/contracts/v1.js";
import type { z } from "zod";

// Web Crypto's digest takes a single buffer. Bound it before reading browser-selected bytes.
export const MAX_DESK_SOURCE_BYTES = 64 * 1024 * 1024;
const ackSchema = UploadStatusSchema.pick({ uploadId: true, nextOffset: true });
type Status = z.infer<typeof UploadStatusSchema>;
interface UploadChannels {
  declare(input: z.infer<typeof createUploadRpc.input>): Promise<Status>;
  status(input: z.infer<typeof getUploadStatusRpc.input>): Promise<Status>;
  write(frame: Uint8Array): Promise<Uint8Array>;
  commit(input: z.infer<typeof commitUploadRpc.input>): Promise<SourceAsset>;
  cancel(input: z.infer<typeof cancelUploadRpc.input>): Promise<z.infer<typeof cancelUploadRpc.output>>;
}

export interface DeskSource {
  name: string;
  size: number;
  type: string;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export class SourceImport {
  private digest?: string;
  private uploadId?: string;
  private declarationSent = false;
  private readyToCommit = false;

  constructor(readonly projectId: string, readonly file: DeskSource, private readonly requestId: string) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_DESK_SOURCE_BYTES)
      throw new Error("请选择非空且不超过 64 MiB 的视频。");
  }

  private async declare(rpc: Pick<UploadChannels, "declare">) {
    const { projectId, file, requestId, digest } = this;
    if (!digest) throw new Error("缺少素材摘要。");
    this.declarationSent = true;
    const created = await rpc.declare({ projectId, requestId, expectedSize: String(file.size), expectedSha256: digest, displayName: file.name, mediaType: file.type || "application/octet-stream" });
    return created.uploadId;
  }

  async transfer(rpc: UploadChannels, hash: (bytes: ArrayBuffer) => Promise<string>, progress: (confirmed: number) => void, signal?: AbortSignal) {
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
      if (status.uploadId !== uploadId || !Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 262144 || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new Error("上传进度无效，请重新选择素材。");
      progress(offset);
      while (offset < file.size) {
        signal?.throwIfAborted();
        const end = Math.min(file.size, offset + chunkSize);
        const bytes = await file.slice(offset, end).arrayBuffer();
        if (bytes.byteLength !== end - offset) throw new Error("所选文件长度已变化，请重新选择。");
        const frame = encodeFramedChunk({ requestId: `${requestId}-${offset}`, uploadId, offset: String(offset), length: String(bytes.byteLength), chunkSha256: await hash(bytes) }, new Uint8Array(bytes));
        signal?.throwIfAborted();
        const ack = ackSchema.parse(JSON.parse(new TextDecoder().decode(await rpc.write(frame))));
        if (ack.uploadId !== uploadId || ack.nextOffset !== String(end)) throw new Error("分块确认与发送内容不符，未提交素材。");
        offset = end;
        progress(offset);
      }
      signal?.throwIfAborted();
      this.readyToCommit = true;
    }
    // If the commit reply was lost, status no longer exists. Replay the original commit directly.
    const asset = await rpc.commit({ uploadId, requestId: `${requestId}-commit`, finalSha256: this.digest });
    return this.verifyReceipt(asset);
  }

  private verifyReceipt(asset: SourceAsset) {
    if (asset.original.sha256 !== this.digest || asset.original.bytes !== String(this.file.size)) throw new Error("素材回执与所选文件不符。");
    return asset;
  }

  async cancel(rpc: Pick<UploadChannels, "declare" | "cancel"> & {
    lookup(input: z.infer<typeof getMutationResultRpc.input>): Promise<z.infer<typeof getMutationResultRpc.output>>;
  }) {
    if (!this.declarationSent) return;
    // Recover the server-assigned ID if the declaration reply was lost.
    this.uploadId ??= await this.declare(rpc);
    try {
      await rpc.cancel({ requestId: `${this.requestId}-cancel`, projectId: this.projectId, uploadId: this.uploadId });
    } catch (error) {
      if (this.readyToCommit) {
        const { mutation } = await rpc.lookup({ projectId: this.projectId, requestId: `${this.requestId}-commit` });
        if (mutation) return this.verifyReceipt(SourceAssetSchema.parse(mutation.response));
      }
      throw error;
    }
    this.uploadId = undefined;
    this.declarationSent = false;
    this.readyToCommit = false;
  }
}
