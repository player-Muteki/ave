import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { editorFailure } from "./errors.js";
import type { BlobRef } from "#video-editor/contracts/v1";

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export class ContentAddressedStore {
  private readonly objects: string;
  private readonly temporary: string;

  constructor(root: string) {
    this.objects = path.join(root, "objects");
    this.temporary = path.join(root, "temporary");
  }

  async initialize(): Promise<void> {
    await mkdir(this.objects, { recursive: true, mode: 0o700 });
    await mkdir(this.temporary, { recursive: true, mode: 0o700 });
  }

  async sizeOf(sha256: string): Promise<bigint> {
    const info = await stat(this.pathFor({ sha256 }));
    return BigInt(info.size);
  }

  pathFor(ref: Pick<BlobRef, "sha256">): string {
    if (!/^[0-9a-f]{64}$/.test(ref.sha256))
      editorFailure("INVALID_ARGUMENT", "Invalid content hash");
    return path.join(this.objects, ref.sha256.slice(0, 2), `${ref.sha256.slice(2)}.blob`);
  }

  temporaryUploadPath(uploadId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(uploadId))
      editorFailure("INVALID_ARGUMENT", "Invalid upload identifier");
    return path.join(this.temporary, `${uploadId}.upload`);
  }

  async writeUploadChunk(uploadId: string, offset: bigint, bytes: Uint8Array): Promise<void> {
    const handle = await open(this.temporaryUploadPath(uploadId), "r+").catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" || offset !== 0n) throw error;
        return open(this.temporaryUploadPath(uploadId), "wx", 0o600);
      },
    );
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const result = await handle.write(
          bytes,
          written,
          bytes.byteLength - written,
          Number(offset) + written,
        );
        if (!result.bytesWritten) editorFailure("INTERNAL", "Unable to persist the upload chunk");
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async commitUpload(
    uploadId: string,
    expectedSha256: string,
    expectedSize: string,
    mediaType: string,
  ): Promise<BlobRef> {
    const temporary = this.temporaryUploadPath(uploadId);
    const info = await stat(temporary).catch(() => null);
    if (!info?.isFile() || info.size.toString() !== expectedSize)
      editorFailure(
        "ARTIFACT_HASH_MISMATCH",
        "The uploaded byte count does not match the declaration",
      );
    const sha256 = await sha256File(temporary);
    if (sha256 !== expectedSha256)
      editorFailure(
        "ARTIFACT_HASH_MISMATCH",
        "The uploaded content hash does not match the declaration",
      );
    const ref = { sha256, bytes: expectedSize, mediaType };
    // Keep acknowledged bytes until the database commits the asset and its receipt together.
    const staging = path.join(this.temporary, `${randomUUID()}.part`);
    try {
      await copyFile(temporary, staging, constants.COPYFILE_FICLONE);
      await this.commitTemporary(staging, ref);
    } finally {
      await rm(staging, { force: true });
    }
    return ref;
  }

  async has(ref: BlobRef): Promise<boolean> {
    const info = await stat(this.pathFor(ref)).catch(() => null);
    return info?.isFile() === true && info.size.toString() === ref.bytes;
  }

  async importFile(source: string, mediaType: string): Promise<BlobRef> {
    const sourceInfo = await stat(source).catch(() => null);
    if (!sourceInfo?.isFile())
      editorFailure("ASSET_NOT_FOUND", "The authorized source is not a regular file");
    const temporary = path.join(this.temporary, `${randomUUID()}.part`);
    const digest = createHash("sha256");
    let bytes = 0n;
    const output = await open(temporary, "wx", 0o600);
    try {
      for await (const chunk of createReadStream(source)) {
        const data = chunk as Buffer;
        digest.update(data);
        bytes += BigInt(data.byteLength);
        await output.write(data);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const ref = { sha256: digest.digest("hex"), bytes: bytes.toString(), mediaType };
    await this.commitTemporary(temporary, ref);
    return ref;
  }

  async writeJson(value: unknown): Promise<BlobRef> {
    return this.writeBytes(Buffer.from(`${JSON.stringify(value, null, 2)}\n`), "application/json");
  }

  async writeBytes(bytes: Uint8Array, mediaType: string): Promise<BlobRef> {
    const temporary = path.join(this.temporary, `${randomUUID()}.part`);
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.write(bytes);
      await output.sync();
    } finally {
      await output.close();
    }
    const ref = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength.toString(),
      mediaType,
    };
    await this.commitTemporary(temporary, ref);
    return ref;
  }

  async readBytes(ref: BlobRef): Promise<Buffer> {
    const bytes = await readFile(this.pathFor(ref));
    if (
      bytes.byteLength.toString() !== ref.bytes ||
      (await sha256File(this.pathFor(ref))) !== ref.sha256
    ) {
      editorFailure("ARTIFACT_HASH_MISMATCH", "Stored content failed its integrity check");
    }
    return bytes;
  }

  async readRange(ref: BlobRef, offset: bigint, length: bigint): Promise<Buffer> {
    const size = BigInt(ref.bytes);
    if (offset < 0n || length <= 0n || offset >= size) {
      editorFailure("RANGE_NOT_SATISFIABLE", "The requested byte range is outside the asset");
    }
    const actualLength = length > size - offset ? size - offset : length;
    const handle = await open(this.pathFor(ref), "r");
    try {
      const bytes = Buffer.alloc(Number(actualLength));
      let filled = 0;
      while (filled < bytes.length) {
        const position = offset + BigInt(filled);
        if (position > BigInt(Number.MAX_SAFE_INTEGER))
          editorFailure("RANGE_NOT_SATISFIABLE", "The byte offset cannot be represented exactly");
        const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, Number(position));
        if (bytesRead === 0)
          editorFailure("ARTIFACT_HASH_MISMATCH", "The stored artifact ended before its declared size");
        filled += bytesRead;
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async removeTemporary(uploadId: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(uploadId)) return;
    await rm(path.join(this.temporary, `${uploadId}.upload`), { force: true });
  }

  private async commitTemporary(temporary: string, ref: BlobRef): Promise<void> {
    const destination = this.pathFor(ref);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await rm(temporary, { force: true });
    }
  }
}
