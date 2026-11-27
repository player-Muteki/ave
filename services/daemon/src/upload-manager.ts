import { createHash } from "node:crypto";
import type { ContentAddressedStore } from "@ave/cas";
import {
  editorFailure,
  type CancelUploadRequest,
  type EditorPrincipal,
  type SourceAsset,
} from "@ave/contracts";
import type { AveStore } from "@ave/sqlite";
import type { DeterministicBackendRegistry } from "./backends/deterministic-backend.js";

export class UploadManager {
  private readonly uploadsInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly store: AveStore,
    private readonly cas: ContentAddressedStore,
    private readonly backends: DeterministicBackendRegistry,
  ) {}

  private async withUpload<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.uploadsInFlight.get(id) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.uploadsInFlight.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.uploadsInFlight.get(id) === tail) this.uploadsInFlight.delete(id);
    }
  }

  async writeUploadChunk(
    uploadId: string,
    offset: string,
    payload: Uint8Array,
    principal: EditorPrincipal,
  ): Promise<string> {
    return this.withUpload(uploadId, async () => {
      const upload = this.store.projects.upload(uploadId);
      this.store.projects.getUploadStatus(upload.projectId, uploadId, principal);
      const end = BigInt(offset) + BigInt(payload.byteLength);
      if (
        !payload.byteLength ||
        payload.byteLength > 262144 ||
        end > BigInt(upload.expectedSize) ||
        end > BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        editorFailure("INVALID_ARGUMENT", "Chunk exceeds the declared upload range");
      }
      const digest = createHash("sha256").update(payload).digest("hex");
      const confirmed = this.store.projects.confirmedChunkHash(uploadId, offset);
      if (confirmed === digest) return upload.nextOffset;
      if (confirmed || upload.nextOffset !== offset) {
        editorFailure("IDEMPOTENCY_CONFLICT", "Chunk conflicts with the confirmed bytes or offset");
      }
      await this.cas.writeUploadChunk(uploadId, BigInt(offset), payload);
      this.store.projects.confirmChunk({
        uploadId,
        offset,
        nextOffset: end.toString(),
        digest,
      });
      return end.toString();
    });
  }

  async cancelUpload(input: CancelUploadRequest, principal: EditorPrincipal) {
    return this.withUpload(input.uploadId, async () => {
      const result = this.store.projects.cancelUpload(input, principal);
      await this.cas.removeTemporaryUpload(input.uploadId);
      return result;
    });
  }

  async commitUpload(
    uploadId: string,
    requestId: string,
    finalSha256: string,
    principal: EditorPrincipal,
  ): Promise<{ projectId: string; asset: SourceAsset }> {
    return this.withUpload(uploadId, async () => {
      const receipt = this.store.projects.committedUpload(
        uploadId,
        requestId,
        finalSha256,
        principal,
      );
      if (receipt) {
        await this.cas.removeTemporaryUpload(uploadId);
        return receipt;
      }
      const upload = this.store.projects.upload(uploadId);
      this.store.projects.getUploadStatus(upload.projectId, uploadId, principal);
      if (upload.nextOffset !== upload.expectedSize) {
        editorFailure("ARTIFACT_HASH_MISMATCH", "Upload has unconfirmed bytes");
      }
      if (upload.expectedSha256 !== finalSha256) {
        editorFailure("ARTIFACT_HASH_MISMATCH", "The final hash differs from the upload declaration");
      }
      const blob = await this.cas.commitUpload(
        uploadId,
        finalSha256,
        upload.expectedSize,
        upload.mediaType,
      );
      const { asset, constantRateStreamUids } = await this.backends.get("ffmpeg").probeAndIndex({
        assetId: `asset-${uploadId}`,
        displayName: upload.displayName,
        originalBlob: blob,
        cas: this.cas,
      });
      for (const streamUid of constantRateStreamUids) {
        this.store.projects.recordConstantRateStream(asset.presentationIndex.sha256, streamUid);
      }
      const result = this.store.projects.finishUpload(uploadId, asset, requestId, principal);
      await this.cas.removeTemporaryUpload(uploadId);
      return { projectId: upload.projectId, asset: result };
    });
  }
}
