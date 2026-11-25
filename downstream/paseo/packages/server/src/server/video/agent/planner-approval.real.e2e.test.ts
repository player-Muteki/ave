import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { encodeFramedChunk } from "#video-editor/bytes";
import {
  PlanningRunStatusSchema,
  ProjectSnapshotSchema,
  SourceAssetSchema,
  UploadStatusSchema,
  type ProjectSnapshot,
} from "#video-editor/contracts/v1";
import { EditorService } from "../service.js";

const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const renderJobs = (snapshot: ProjectSnapshot) =>
  snapshot.jobs.filter((job) => job.kind !== "analysis");

test.runIf(process.env.VIDEO_EDITOR_LIVE_PLANNER === "1")(
  "the real planner proposes the requested trim and waits for approval before rendering",
  async () => {
    expect(
      process.env.VIDEO_EDITOR_PLANNER_MODEL,
      "Select a model explicitly for this test",
    ).toBeTruthy();
    const root = await mkdtemp(path.join(tmpdir(), "ave-live-planner-"));
    const editor = await EditorService.create({ paseoHome: path.join(root, "home") });
    try {
      await editor.start();
      const source = path.join(root, "source.mp4");
      await execute(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=128x72:rate=24:duration=2",
          "-f",
          "lavfi",
          "-i",
          "sine=sample_rate=48000:duration=2",
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          "-shortest",
          source,
        ],
        { timeout: 15_000 },
      );
      const bytes = await readFile(source);
      const sourceHash = sha256(bytes);
      const owner = editor.principalForOwner();
      const invoke = (method: string, input: unknown) =>
        editor.rpc.invoke(`video.v1.${method}`, input, {
          principalId: owner.principalId,
          editorPrincipal: owner,
          permissions: [],
        });
      const { projectId } = ProjectSnapshotSchema.parse(
        await invoke("create_project", {
          requestId: "project",
          title: "Planner approval",
        }),
      );
      const { uploadId } = UploadStatusSchema.parse(
        await invoke("create_upload", {
          projectId,
          requestId: "upload",
          displayName: "source.mp4",
          mediaType: "video/mp4",
          expectedSize: String(bytes.length),
          expectedSha256: sourceHash,
        }),
      );
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        const chunk = bytes.subarray(offset, offset + 64 * 1024);
        await invoke(
          "write_upload_chunk",
          encodeFramedChunk(
            {
              uploadId,
              requestId: `chunk-${offset}`,
              offset: String(offset),
              length: String(chunk.length),
              chunkSha256: sha256(chunk),
            },
            chunk,
          ),
        );
      }
      const asset = SourceAssetSchema.parse(
        await invoke("commit_upload", {
          uploadId,
          requestId: "commit",
          finalSha256: sourceHash,
        }),
      );
      const initial = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId }));
      expect(initial.plans).toEqual([]);
      expect(renderJobs(initial)).toEqual([]);

      const { runId } = PlanningRunStatusSchema.parse(
        await invoke("start_planning_run", {
          projectId,
          requestId: "plan",
          prompt:
            "Keep the single imported video's segment from 0.5 to 1.5 seconds, preserving its audio. Submit it for review.",
        }),
      );
      const lifecycle = () =>
        editor.store.runLifecycle(projectId, owner).find((run) => run.runId === runId)?.state;
      await expect
        .poll(lifecycle, { timeout: 150_000, interval: 250 })
        .toMatch(/^(settled|failed|interrupted)$/);
      expect(lifecycle()).toBe("settled");

      const result = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId }));
      expect(result.plans).toHaveLength(1);
      const [plan] = result.plans;
      expect(plan).toMatchObject({ runId, status: "proposed", deterministicBackendId: "ffmpeg" });
      expect(plan.trimOperations).toHaveLength(1);
      expect(plan).toMatchObject({
        transformOperations: [],
        audioOperations: [],
        transitionOperations: [],
        subtitleOperations: [],
        generationRequests: [],
        externalDestinations: [],
      });
      const [trim] = plan.trimOperations;
      expect(trim.source).toMatchObject({ assetId: asset.assetId, assetContentHash: sourceHash });
      expect(trim.source.streamUid).toBe(
        asset.streams.find((stream) => stream.kind === "video")?.streamUid,
      );
      expect(BigInt(trim.sourceRange.start.num) * 2n).toBe(BigInt(trim.sourceRange.start.den));
      expect(trim.sourceRange.duration.num).toBe(trim.sourceRange.duration.den);
      expect(trim.recordRange.start.num).toBe("0");
      expect(trim.recordRange.duration.num).toBe(trim.recordRange.duration.den);
      expect(result.approvals).toMatchObject([
        {
          subjectType: "edit_plan",
          subjectId: plan.planId,
          planHash: plan.planHash,
          status: "pending",
          purpose: "preview",
        },
      ]);
      await expect(
        invoke("create_job", {
          projectId,
          requestId: "unapproved-preview",
          approvalId: result.approvals[0].approvalId,
          grantId: "unapproved",
          expectedRevision: result.revision,
        }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(
        renderJobs(ProjectSnapshotSchema.parse(await invoke("get_project", { projectId }))),
      ).toEqual([]);
      expect(sha256(await readFile(source))).toBe(sourceHash);
    } finally {
      await editor.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
