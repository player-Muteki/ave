import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { encodeFramedChunk } from "#video-editor/bytes";
import {
  EventsResultSchema,
  PlanningRunStatusSchema,
  ProjectSnapshotSchema,
  UploadStatusSchema,
} from "#video-editor/contracts/v1";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";

const execute = promisify(execFile);

test.skipIf(process.env.VIDEO_EDITOR_LIVE_PLANNER_TEST !== "1")(
  "a real model proposes a source trim that waits for human approval",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "live-planner-approval-"));
    try {
      const source = path.join(root, "fixture.mp4");
      await execute("ffmpeg", [
        "-nostdin", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:v", "libx264", "-c:a", "aac", "-shortest", source,
      ], { timeout: 30_000 });
      const bytes = await readFile(source);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
      const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      try {
        await client.connect();
        const invoke = (method: string, input: unknown) =>
          client.invokePluginRpc("video-editor", `video.v1.${method}`, input);
        const { projectId } = ProjectSnapshotSchema.parse(await invoke("create_project", {
          requestId: "project", title: "自然语言规划验收",
        }));
        const upload = UploadStatusSchema.parse(await invoke("create_upload", {
          requestId: "upload",
          projectId,
          displayName: "fixture.mp4",
          expectedSize: String(bytes.length),
          expectedSha256: digest,
          mediaType: "video/mp4",
        }));
        await invoke("write_upload_chunk", encodeFramedChunk({
          requestId: "write",
          uploadId: upload.uploadId,
          offset: "0",
          length: String(bytes.length),
          chunkSha256: digest,
        }, bytes));
        await invoke("commit_upload", {
          requestId: "commit", uploadId: upload.uploadId, finalSha256: digest,
        });

        const getProject = async () =>
          ProjectSnapshotSchema.parse(await invoke("get_project", { projectId }));
        const baseline = await getProject();
        const run = PlanningRunStatusSchema.parse(await invoke("start_planning_run", {
          requestId: "plan",
          projectId,
          prompt: "把唯一视频素材裁成前一秒，保留原声，提交方案供审批。",
        }));
        const getEvents = async () => EventsResultSchema.parse(await invoke("get_events", {
          projectId, afterSeq: baseline.latestSeq,
        })).events;
        const terminal = async () => (await getEvents()).findLast(event =>
          event.runId === run.runId &&
          ["run.settled", "run.failed", "run.interrupted"].includes(event.type),
        )?.type;
        await expect.poll(terminal, { timeout: 90_000 }).toBeDefined();
        expect(await terminal()).toBe("run.settled");

        const saved = await getProject();
        expect(saved.plans).toHaveLength(1);
        const [plan] = saved.plans;
        expect(plan!.runId).toBe(run.runId);
        expect(plan!.trimOperations).toHaveLength(1);
        const [trim] = plan!.trimOperations;
        expect(trim!.source.assetId).toBe(baseline.assets[0]?.assetId);
        expect(trim!.source.assetContentHash).toBe(digest);
        expect(BigInt(trim!.sourceRange.start.num)).toBe(0n);
        expect(BigInt(trim!.sourceRange.duration.num)).toBe(BigInt(trim!.sourceRange.duration.den));
        expect(saved.approvals).toHaveLength(1);
        expect(saved.approvals[0]).toMatchObject({
          status: "pending", purpose: "preview", subjectId: plan!.planId, subjectHash: plan!.planHash,
        });
        expect(saved.jobs).toEqual([]);
        expect(await getEvents()).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "plan.proposed" }),
          expect.objectContaining({ type: "approval.requested" }),
        ]));
        expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(digest);
      } finally {
        try {
          await client.close();
        } finally {
          await daemon.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  150_000,
);
