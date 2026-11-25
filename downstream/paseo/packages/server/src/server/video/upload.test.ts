import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EditorService } from "./service.js";
import { SourceImport } from "../../../../../plugins/video-editor/client/import-source.js";
import { commitUploadRpc, createUploadRpc, getUploadStatusRpc, writeUploadChunkRpc } from "#video-editor/contracts/v1";
import { decodeChunkMetadata } from "#video-editor/bytes";

it("resumes from confirmed bytes after restart without overwriting acknowledged chunks", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "editor-upload-"));
  let editor = await EditorService.create({ paseoHome: home });
  try {
    await editor.start();
    const principal = editor.principalForOwner();
    const project = editor.store.createProject({
      title: "transfer",
      requestId: "create",
      principal,
    });
    const declaration = {
      projectId: project.projectId,
      expectedSize: "6",
      expectedSha256: "f".repeat(64),
      displayName: "media",
      mediaType: "video/mp4",
      principal,
      requestId: "upload",
    };
    const created = editor.store.createUpload(declaration);
    const id = created.uploadId;
    expect(editor.store.createUpload(declaration)).toEqual(created);
    expect(() => editor.store.createUpload({ ...declaration, expectedSize: "7" })).toThrow(
      "different content",
    );
    const write = (offset: string, bytes: string) =>
      editor.media.writeUploadChunk(id, offset, Buffer.from(bytes), principal);
    expect(await Promise.all([write("0", "abc"), write("0", "abc")])).toEqual(["3", "3"]);
    await editor.stop();
    editor = await EditorService.create({ paseoHome: home });
    await editor.start();
    expect(editor.store.createUpload(declaration)).toEqual(created);
    expect(editor.store.uploadStatus(project.projectId, id, principal).nextOffset).toBe("3");
    await expect(write("0", "xyz")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(write("4", "x")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(write("3", "")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(write("3", "defg")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await write("3", "def")).toBe("6");
    expect(await write("0", "abc")).toBe("6");
    expect(await readFile(editor.cas.temporaryUploadPath(id), "utf8")).toBe("abcdef");
  } finally {
    await editor.stop();
    await rm(home, { recursive: true, force: true });
  }
});

it("retains confirmed bytes through probe failure and replays a committed receipt after restart", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "upload-receipt-"));
  const noProbe = { paseoHome: home, ffprobe: path.join(home, "no-ffprobe") };
  let editor = await EditorService.create(noProbe);
  try {
    const source = path.join(home, "clip.mp4");
    await promisify(execFile)(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=size=32x32:rate=10:duration=0.2",
        "-c:v",
        "libx264",
        source,
      ],
      { timeout: 30000 },
    );
    const bytes = await readFile(source);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await editor.start();
    const principal = editor.principalForOwner();
    const { projectId } = editor.store.createProject({
      title: "recovery",
      requestId: "project",
      principal,
    });
    const { uploadId } = editor.store.createUpload({
      projectId,
      requestId: "upload",
      displayName: "clip.mp4",
      expectedSize: String(bytes.length),
      expectedSha256: digest,
      mediaType: "video/mp4",
      principal,
    });
    await editor.media.writeUploadChunk(uploadId, "0", bytes, principal);
    const commit = () => editor.media.commitUpload(uploadId, "commit", digest, principal);
    await expect(commit()).rejects.toThrow();
    expect(await readFile(editor.cas.temporaryUploadPath(uploadId))).toEqual(bytes);
    expect(editor.store.project(projectId, principal).assets).toHaveLength(0);
    await editor.stop();
    editor = await EditorService.create({ paseoHome: home });
    await editor.start();
    const result = await commit();
    expect(result.original.sha256).toBe(digest);
    const snapshot = editor.store.project(projectId, principal);
    expect(snapshot.assets).toHaveLength(1);
    const second = editor.store.createProject({
      title: "same bytes",
      requestId: "project-2",
      principal,
    });
    const secondUpload = editor.store.createUpload({
      projectId: second.projectId,
      requestId: "upload",
      displayName: "different name.mp4",
      expectedSize: String(bytes.length),
      expectedSha256: digest,
      mediaType: "video/mp4",
      principal,
    });
    await editor.media.writeUploadChunk(secondUpload.uploadId, "0", bytes, principal);
    const secondAsset = await editor.media.commitUpload(
      secondUpload.uploadId,
      "commit",
      digest,
      principal,
    );
    expect(secondAsset.original).toEqual(result.original);
    expect(secondAsset.assetId).not.toBe(result.assetId);
    expect(secondAsset.displayName).toBe("different name.mp4");
    expect(() =>
      editor.store.asset(projectId, secondAsset.assetId, snapshot.revision, principal),
    ).toThrow("does not exist in this project");
    await expect(readFile(editor.cas.temporaryUploadPath(uploadId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await editor.stop();
    editor = await EditorService.create(noProbe);
    await editor.start();
    expect(await commit()).toEqual(result);
    expect(editor.store.project(projectId, principal)).toEqual(snapshot);
  } finally {
    await editor.stop();
    await rm(home, { recursive: true, force: true });
  }
});

it("imports a desk file once when a chunk ack and the commit reply are individually lost", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "desk-file-import-"));
  const editor = await EditorService.create({ paseoHome: home });
  try {
    await editor.start();
    const principal = editor.principalForOwner();
    const {projectId} = editor.store.createProject({title:"Desk import",principal,requestId:"p"});
    const pathToSource = path.join(home,"source.mkv");
    await promisify(execFile)("ffmpeg", ["-v","error","-f","lavfi","-i","color=size=32x32:rate=2:duration=4","-f","lavfi","-i","anullsrc=r=48000:cl=mono","-t","4","-c:v","libx264","-c:a","pcm_s16le",pathToSource], {timeout:30000});
    const bytes = await readFile(pathToSource);
    expect(bytes.length).toBeGreaterThan(262144);
    const file = new File([new Uint8Array(bytes)], "选中的镜头.mkv", {type:"video/x-matroska"});
    const transfer = new SourceImport(projectId, file, "desk-import");
    const invoke = (method:string, input:unknown) => editor.rpc.invoke(method,input,{principalId:"owner", permissions:["daemon.manage"]});
    let loseChunk = true, loseCommit = true;
    const offsets: string[] = [];
    const channels: Parameters<SourceImport["transfer"]>[0] = {
      declare: async input => createUploadRpc.output.parse(await invoke(createUploadRpc.name,input)),
      status: async input => getUploadStatusRpc.output.parse(await invoke(getUploadStatusRpc.name,input)),
      write: async frame => {
        offsets.push(String(decodeChunkMetadata(frame).offset));
        const ack = writeUploadChunkRpc.output.parse(await invoke(writeUploadChunkRpc.name,writeUploadChunkRpc.input.parse(frame)));
        if(loseChunk){loseChunk=false;throw Error("lost chunk ack");}return ack;
      },
      commit: async input => {
        const asset = commitUploadRpc.output.parse(await invoke(commitUploadRpc.name,input));
        if(loseCommit){loseCommit=false;throw Error("lost commit reply");}return asset;
      },
    };
    const confirmed:number[] = [];
    const send = () => transfer.transfer(channels, async data => createHash("sha256").update(new Uint8Array(data)).digest("hex"), n=>confirmed.push(n));
    await expect(send()).rejects.toThrow("lost chunk ack");
    await expect(send()).rejects.toThrow("lost commit reply");
    const afterCommit=editor.store.project(projectId,principal);
    const receipt=await send();
    expect(offsets).toEqual(["0", "262144"]);
    expect(confirmed).toEqual([0,262144,bytes.length]);
    expect(receipt.displayName).toBe(file.name);
    expect(receipt.original.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readFile(editor.cas.pathFor(receipt.original))).toEqual(bytes);
    expect(afterCommit.assets).toEqual([receipt]);
    expect(editor.store.project(projectId,principal)).toEqual(afterCommit);
  } finally {
    await editor.stop();
    await rm(home,{recursive:true,force:true});
  }
});

it("enforces the per-chunk size ceiling", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "editor-upload-chunksize-"));
  const editor = await EditorService.create({ paseoHome: home });
  try {
    await editor.start();
    const principal = editor.principalForOwner();
    const project = editor.store.createProject({ title: "chunksize", requestId: "create", principal });
    const created = editor.store.createUpload({
      projectId: project.projectId,
      expectedSize: "1000000",
      expectedSha256: "f".repeat(64),
      displayName: "media",
      mediaType: "video/mp4",
      principal,
      requestId: "upload",
    });
    const id = created.uploadId;
    // One byte over the 262144-byte chunk ceiling is rejected.
    await expect(
      editor.media.writeUploadChunk(id, "0", Buffer.alloc(262145), principal),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Exactly the ceiling is accepted and advances the offset.
    expect(
      await editor.media.writeUploadChunk(id, "0", Buffer.alloc(262144), principal),
    ).toBe("262144");
  } finally {
    await editor.stop();
    await rm(home, { recursive: true, force: true });
  }
});
