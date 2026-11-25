import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { decodeFramedChunk, encodeFramedChunk } from "#video-editor/bytes";
import { EventsResultSchema, EditPlanDraftV1Schema, TrackedMaskManifestSchema, MaskAnchorRevisionSchema, ProjectSnapshotSchema, UploadStatusSchema } from "#video-editor/contracts/v1";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DatabaseSync } from "./sqlite.js";
import { ContentAddressedStore } from "./cas.js";
import { BuiltinPluginLoader, builtinPlugins } from "../plugins/builtin/index.js";

const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../../../../../", import.meta.url));

// Opt-in: requires agent-browser and a local Chrome binary. Never attaches to a user's browser.
test
  .skipIf(process.env.VIDEO_EDITOR_BROWSER_TEST !== "1")
  .each(["source import", "preview approval and reviewed delivery", "reject preview", "project creation and discovery", "remove verified silence",
    ...(process.env.VIDEO_EDITOR_LIVE_PLANNER === "1" ? ["last-second planning approval"] : []),
    ...(process.env.VIDEO_EDITOR_SAM2_TEST === "1" ? ["object mask"] : [])])(
  "edit desk: %s",
  async (scenario) => {
    const session = `edit-desk-${randomUUID()}`;
    const web = async (...args: string[]) =>
      (await execute("agent-browser", ["--session", session, ...args], { timeout: 25000 })).stdout;
    const root = await mkdtemp(path.join(tmpdir(), "edit-desk-qa-"));
    let bundle = "";
    const server = createServer((req, res) => {
      if (req.url === "/desk.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.end(bundle);
        return;
      }
      res.setHeader("Content-Type", "text/html;charset=utf-8");
      res.end(
        '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>剪辑工作台测试</title><div id="root"></div><script src="/desk.js"></script></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local port");
    const origin = `http://127.0.0.1:${address.port}`;
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      corsAllowedOrigins: [origin],
      daemonVersion: "0.17.4",
      builtinPlugins: new BuiltinPluginLoader(path.join(repo, "plugins"), builtinPlugins.filter(id => id === "video-editor")),
    });
    const ws = `ws://127.0.0.1:${daemon.port}/ws`;
    const owner = new DaemonClient({ url: ws });
    try {
      await owner.connect();
      const invoke = (method: string, input: unknown) =>
        owner.invokePluginRpc("video-editor", `video.v1.${method}`, input);
      const project = ProjectSnapshotSchema.parse(
        await invoke("create_project", { title: "镜头测试", requestId: "project" }),
      );
      const tailRequest = scenario === "last-second planning approval";
      const silenceCut = scenario === "remove verified silence";
      const matroska = tailRequest || silenceCut;
      const source = path.join(root, matroska ? "offset.mkv" : "clip.mp4");
      if (tailRequest) {
        // Audio starts at native PTS 2.00 s and video at 2.12 s. Both end at 4.40 s.
        await execute("ffmpeg", [
          "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x48:rate=25:duration=2.4",
          "-f", "lavfi", "-i", "sine=sample_rate=8000:duration=2.4", "-vf", "select='gte(n,3)*not(eq(n,5))'",
          "-fps_mode", "vfr", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-output_ts_offset", "2", source,
        ], { timeout: 30000 });
      } else if (silenceCut) {
        // 57 frames total. Removing the middle second leaves 32 frames with two distinct tones.
        await execute("ffmpeg", [
          "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=2.28",
          "-f", "lavfi", "-i",
          "aevalsrc='if(lt(t,0.6),0.3*sin(2*PI*440*t),if(lt(t,1.6),0,0.3*sin(2*PI*880*t)))':s=48000:d=2.28",
          "-c:v", "libx264", "-c:a", "pcm_s16le", source,
        ]);
      } else {
        await execute(
          "ffmpeg",
          [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            scenario === "object mask" ? "color=c=navy:size=320x192:rate=25:duration=2[bg];color=c=orange:size=84x72:rate=25:duration=2[box];[bg][box]overlay=x=96+5*n:y=60"
              : "testsrc2=size=160x90:rate=25:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
            "-c:a", "aac",
            "-c:v",
            "libx264",
            source,
          ],
          { timeout: 30000 },
        );
      }
      const bytes = await readFile(source);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (scenario !== "source import" && scenario !== "project creation and discovery") {
        const upload = UploadStatusSchema.parse(
          await invoke("create_upload", {
            projectId: project.projectId,
            requestId: "upload",
            displayName: matroska ? "镜头 A.mkv" : "镜头 A.mp4",
            expectedSize: String(bytes.length),
            expectedSha256: digest,
            mediaType: matroska ? "video/x-matroska" : "video/mp4",
          }),
        );
        await invoke(
          "write_upload_chunk",
          encodeFramedChunk(
            {
              requestId: "write",
              uploadId: upload.uploadId,
              offset: "0",
              length: String(bytes.length),
              chunkSha256: digest,
            },
            bytes,
          ),
        );
        await invoke("commit_upload", {
          requestId: "commit",
          uploadId: upload.uploadId,
          finalSha256: digest,
        });
      }
      const plugin = (await owner.getPluginCatalog()).find(entry => entry.id === "video-editor");
      if (!plugin?.clientBundle) throw new Error("Video editor was not published by the daemon");
      expect(createHash("sha256").update(plugin.clientBundle).digest("hex")).toBe(plugin.clientBundleHash);
      // The harness provides only the installation's host modules and a real WS client. The rendered
      // screen and its callbacks are obtained from the compiled plugin registration, not a duplicate UI.
      const result = await build({
        bundle: true,
        write: false,
        platform: "browser",
        alias: { "react-native": "react-native-web" },
        define: { "process.env.NODE_ENV": '"production"', __DEV__: "false" },
        stdin: {
          resolveDir: repo,
          loader: "tsx",
          contents: `
      import * as React from 'react';import * as jsx from 'react/jsx-runtime';import * as RN from 'react-native-web';import * as zod from 'zod';import {createRoot} from 'react-dom/client';
      import {useRpc} from '@getpaseo/plugin/client';import {PluginRpcProvider} from '@getpaseo/plugin/client/host';
      import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
      const modules={'react':React,'react/jsx-runtime':jsx,'react-native':RN,'zod':zod,'@getpaseo/plugin/client':{useRpc},'@getpaseo/plugin/client/ui':{}};
      let Screen; const plugin=(${plugin.clientBundle})(id=>{if(!modules[id])throw Error('Unexpected module '+id);return modules[id]});
      const dispose = plugin.default({
        addScreen: ({Component}) => { Screen = Component; return () => { Screen = undefined }; },
        addSidebarHeaderItem: () => () => {},
      });
      if (typeof dispose !== 'function') throw Error('Missing plugin cleanup function');
      const daemon=new DaemonClient({url:${JSON.stringify(ws)},clientId:'qa-desk',clientType:'browser'});
      const colors={surface0:'#17222d',foreground:'#f1f6fa',foregroundMuted:'#becbd6',accent:'#3875b4',accentForeground:'#ffffff',statusDanger:'#ffb4af'};
      daemon.connect().then(()=>createRoot(document.getElementById('root')).render(<PluginRpcProvider invoke={(method,input)=>daemon.invokePluginRpc('video-editor',method,input)}><Screen layout={{compact:false,platform:'web'}} theme={{colors}} host={{id:'local',label:'QA'}} /></PluginRpcProvider>)).catch(e=>document.body.textContent=e.message);
    `,
        },
      });
      bundle = result.outputFiles[0]!.text;
      await web(
        "--executable-path",
        process.env.CHROME_BIN ?? "/usr/bin/google-chrome",
        "open",
        origin,
      );
      const clickDesk = async (label: string) => {
        await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>(n.getAttribute("aria-label") || n.textContent)===${JSON.stringify(label)})?.scrollIntoView({block:'center'}); true`);
        await web("find", "role", "button", "click", "--name", label);
      };
      await web("wait", '[aria-label="项目 ID"]');
      if (scenario === "project creation and discovery") {
        // Create a project from the desk itself (not the RPC fixture) and confirm the
        // daemon recorded it, then exercise the discovery list button.
        await web("fill", '[aria-label="新项目名称"]', "界面创建项目");
        await web("find", "role", "button", "click", "--name", "创建项目");
        await web("wait", "--text", "版本 0 · 0 份素材");
        const listed = (await invoke("list_projects", {})) as {
          projects: Array<{ projectId: string; title: string; revision: string }>;
        };
        const created = listed.projects.find((entry) => entry.title === "界面创建项目");
        expect(created).toBeDefined();
        expect(created?.revision).toBe("0");
        expect(
          ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: created!.projectId })),
        ).toMatchObject({ title: "界面创建项目", revision: "0", assets: [] });
        // The discovery button lists both the UI-created project and the RPC fixture.
        await web("find", "role", "button", "click", "--name", "列出可访问项目");
        await web("wait", "--text", "镜头测试");
        const snapshot = await web("snapshot");
        expect(snapshot).toContain("界面创建项目");
        expect(snapshot).toContain("镜头测试");
        expect(snapshot).toContain(created!.projectId);
        return;
      }
      await web("fill", '[aria-label="项目 ID"]', project.projectId);
      await web("find", "role", "button", "click", "--name", "打开项目");
      if (tailRequest) {
        await web("fill", '[aria-label="规划意图（自然语言）"]', "只保留唯一视频素材的最后一秒和原声，提交给我审批。");
        await clickDesk("开始规划");
        const getEvents = async () => EventsResultSchema.parse(await invoke("get_events", {
          projectId: project.projectId, afterSeq: project.latestSeq,
        })).events;
        await expect.poll(async () => (await getEvents()).findLast(event =>
          ["run.settled", "run.failed", "run.interrupted"].includes(event.type),
        )?.type, { timeout: 150_000, interval: 500 }).toBeDefined();
        const events = await getEvents();
        const settled = events.find(event => event.type === "run.settled");
        expect(settled?.runId).toBeTruthy();
        await clickDesk("刷新事件");
        await web("wait", "--text", "预览审批");
        const snapshot = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: project.projectId }));
        expect(snapshot.plans).toHaveLength(1);
        const plan = snapshot.plans[0]!;
        expect(plan).toMatchObject({
          runId: settled!.runId, status: "proposed", deterministicBackendId: "ffmpeg",
          transformOperations: [], subtitleOperations: [], transitionOperations: [], generationRequests: [],
          externalDestinations: [],
        });
        expect(plan.trimOperations).toHaveLength(1);
        const trim = plan.trimOperations[0]!;
        expect(trim.trackId).toBe("v1");
        expect(trim.fadeIn).toBeUndefined();
        expect(trim.fadeOut).toBeUndefined();
        const asset = snapshot.assets[0]!;
        expect(trim.source).toMatchObject({
          assetId: asset.assetId, assetContentHash: digest,
          streamUid: asset.streams.find(stream => stream.kind === "video")!.streamUid,
        });
        for (const audio of plan.audioOperations) {
          expect(audio.source).toMatchObject({
            assetId: asset.assetId, assetContentHash: digest,
            streamUid: asset.streams.find(stream => stream.kind === "audio")!.streamUid,
          });
          expect(BigInt(audio.gainMilli)).toBe(0n);
          expect(audio.mute).toBe(false);
          expect(audio.fadeIn).toBeUndefined();
          expect(audio.fadeOut).toBeUndefined();
          expect(BigInt(audio.sourceRange.start.num) * 5n).toBe(BigInt(audio.sourceRange.start.den) * 7n);
          expect(BigInt(audio.sourceRange.duration.num)).toBe(BigInt(audio.sourceRange.duration.den));
        }
        // The user's last second is [1.40, 2.40) in playback time.
        expect(BigInt(trim.sourceRange.start.num) * 5n).toBe(BigInt(trim.sourceRange.start.den) * 7n);
        for (const time of [trim.sourceRange.duration, trim.recordRange.duration])
          expect(BigInt(time.num)).toBe(BigInt(time.den));
        expect(BigInt(trim.recordRange.start.num)).toBe(0n);
        expect(snapshot.approvals).toMatchObject([{
          purpose: "preview", status: "pending", subjectId: plan.planId, subjectHash: plan.planHash,
        }]);
        expect(await web("snapshot")).toContain(plan.planHash);
        expect(snapshot.jobs.filter(job => job.kind !== "analysis")).toEqual([]);
        expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(digest);
        return;
      }
      if (scenario === "source import") {
        await web("wait", "--text", "项目中还没有素材");
        const picker = 'input[type="file"][aria-label="选择本机视频"]';
        await web("wait", picker);
        await web("upload", picker, source);
        await web("wait", "--text", "导入所选视频");
        const staged = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: project.projectId }));
        expect(staged.assets).toHaveLength(0);
        expect(staged.revision).toBe(project.revision);
        await web("find", "role", "button", "click", "--name", "导入所选视频");
        await web("wait", '[aria-label="入点（秒，含）"]');
        expect(await web("snapshot")).toContain("clip.mp4");
        const imported = ProjectSnapshotSchema.parse(
          await invoke("get_project", { projectId: project.projectId }),
        );
        expect(imported.assets).toHaveLength(1);
        expect(imported.assets[0]).toMatchObject({
          displayName: "clip.mp4",
          original: { sha256: digest, bytes: String(bytes.length) },
        });
        await clickDesk("元数据");
        await web("wait", "--text", "50 帧 · 160x90");
        await clickDesk("生成联系表");
        await web("wait", "--text", "查看联系表").catch(async (cause) => {
          throw new Error(`Contact sheet did not appear: ${await web("snapshot")}`, { cause });
        });
        await clickDesk("查看联系表");
        await web("wait", "--fn", `document.querySelector('img[alt^="contact sheet"]')?.naturalWidth > 0`);
        expect(imported.jobs).toMatchObject([{ kind: "analysis", analysisAssetId: imported.assets[0]!.assetId }]);
        expect(imported.approvals).toHaveLength(0);
        await web("fill", '[aria-label="源帧序号（从零开始）"]', "4");
        await clickDesk("查看源帧");
        await web("wait", "--text", "源帧 4 / 49 · PTS 2048 × 1/12800 · 160×90");
        await web("wait", '[aria-label="点选源帧"]');
        const asset = imported.assets[0]!;
        const request = { projectId: imported.projectId, assetId: asset.assetId, streamUid: asset.streams[0]!.streamUid,
          sourcePresentationIndexHash: asset.presentationIndex.sha256, frame: 4, points: [] };
        await expect(invoke("inspect_frame", { ...request, frame: 50 })).rejects.toThrow();
        await expect(invoke("inspect_frame", { ...request, sourcePresentationIndexHash: "0".repeat(64) })).rejects.toThrow();
        return;
      }
      await web("wait", '[aria-label="入点（秒，含）"]');
      if (scenario === "object mask") {
        await web("fill", '[aria-label="源帧序号（从零开始）"]', "4");
        await clickDesk("查看源帧");
        await web("wait", "--text", "320×192");
        const img = "document.querySelector('[aria-label=\"点选源帧\"] img')";
        await web("wait", "--fn", `${img}?.naturalWidth === 320`);
        const sourceImage = await web("eval", `${img}.src`);
        await clickDesk("点选源帧");
        await web("wait", "--text", "SAM2 掩码 · 1 个点");
        const summary = await web("snapshot");
        const area = Number(/SAM2 掩码 · 1 个点 · (\d+) 个前景像素/.exec(summary)?.[1]);
        // The known rectangle covers 6,120 pixels; excessive background also fails.
        expect(area).toBeGreaterThan(5500);
        expect(area).toBeLessThan(6700);
        expect(await web("eval", `${img}.src`)).not.toBe(sourceImage);
        await clickDesk("添加背景点");
        const [x,y] = JSON.parse(await web("eval", `(() => {
          const b = ${img}.getBoundingClientRect(); return [Math.round(b.left + b.width / 8), Math.round(b.top + b.height / 8)];
        })()`)) as [number, number];
        await web("mouse", "move", String(x), String(y));
        await web("mouse", "down");
        await web("mouse", "up");
        await web("wait", "--text", "SAM2 掩码 · 2 个点");
        const reviewedImage = await web("eval", `${img}.src`);
        await clickDesk("保存掩码供审批");
        await web("wait", "--text", "输入掩码待审批");
        const saved = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(saved.jobs.filter(j => !j.analysisAssetId)).toHaveLength(0);
        const [approval] = saved.approvals;
        expect(approval).toMatchObject({status: "pending", purpose: "input", subjectType: "mask_revision"});
        const track = {projectId: saved.projectId, expectedRevision: saved.revision, anchorApprovalId: approval!.approvalId,
          anchorHash: approval!.subjectHash, firstFrame: 0, frameCount: 9};
        await expect(invoke("track_mask", {...track, requestId: "unapproved"})).rejects.toThrow();
        const review = decodeFramedChunk(await invoke("get_mask_revision", {
          projectId: project.projectId, maskRevisionId: approval!.subjectId,
        }) as Uint8Array);
        expect(createHash("sha256").update(review.metadata).digest("hex")).toBe(approval!.subjectHash);
        const revision = MaskAnchorRevisionSchema.parse(JSON.parse(new TextDecoder().decode(review.metadata)));
        expect(revision.anchor.points.map(p => p.foreground)).toEqual([true, false]);
        expect(revision.rawLabelMask).toMatchObject({bytes: String(320*192), sha256: revision.anchor.mask.labelSha256});
        expect(revision.reviewImage.sha256).toBe(createHash("sha256").update(review.payload).digest("hex"));
        expect(revision.anchor.sourceSha256).toBe(digest);
        const cas = new ContentAddressedStore(path.join(daemon.paseoHome, "video-editor", "cas"));
        const raw = await cas.readBytes(revision.rawLabelMask);
        expect(raw.every(v => v === 0 || v === 255)).toBe(true);
        expect(raw.reduce((n,v) => n + Number(v !== 0), 0)).toBe(revision.anchor.mask.foregroundPixels);
        for (const point of revision.anchor.points) expect(raw[point.y * 320 + point.x]).toBe(point.foreground ? 255 : 0);
        await clickDesk("清除点选");
        await web("wait", "--fn", "!document.body.textContent.includes('SAM2 掩码')");
        expect(await web("eval", `${img}.src`)).toBe(sourceImage);
        await web("reload");
        await web("wait", '[aria-label="项目 ID"]');
        await web("fill", '[aria-label="项目 ID"]', project.projectId);
        await clickDesk("打开项目");
        await clickDesk("查看保存的掩码");
        await web("wait", '[aria-label="保存的掩码审片图"] img');
        const restoredImage = await web("eval", "document.querySelector('[aria-label=\"保存的掩码审片图\"] img').src");
        expect(restoredImage).toBe(reviewedImage);
        // Simulate unavailable generated bytes after review in this test's isolated CAS.
        const labelPath = cas.pathFor(revision.rawLabelMask);
        await rename(labelPath, labelPath + ".offline");
        try {
          await expect(invoke("decide_approval", {requestId: "missing-label", approvalId: approval!.approvalId,
            decision: "approve", expectedRevision: saved.revision})).rejects.toThrow();
          const afterFailure = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
          expect(afterFailure.approvals[0]?.status).toBe("pending");
        } finally { await rename(labelPath + ".offline", labelPath); }
        await clickDesk("批准此输入掩码");
        await web("wait", "--text", "输入掩码已批准");
        const approved = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(approved.jobs.filter(j => !j.analysisAssetId)).toHaveLength(0);
        expect(approved.approvals).toHaveLength(1);
        expect(approved.approvals[0]).toMatchObject({status: "approved", purpose: "input", subjectHash: approval!.subjectHash});
        await expect(invoke("track_mask", {...track, firstFrame: 5, requestId:"outside-anchor"})).rejects.toThrow();
        await clickDesk("传播已批准的掩码");
        await expect.poll(async () => {
          const p = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
          if (p.jobs.find(j => !j.analysisAssetId)?.state === "failed") throw Error(JSON.stringify(p.jobs.find(j => !j.analysisAssetId)?.error));
          return p.jobs.find(j => !j.analysisAssetId)?.state;
        }, {timeout: 45000}).toBe("completed");
        const finished = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(finished.approvals).toHaveLength(1);
        const job = finished.jobs.find(j => !j.analysisAssetId)!;
        expect(job.analysisAssetId).toBeUndefined();
        const artifact = job.artifacts.find(a => a.kind === "mask")!;
        const manifest = TrackedMaskManifestSchema.parse(JSON.parse((await cas.readBytes(artifact.blob)).toString("utf8")));
        expect(manifest.frames[4]!.label).toEqual(revision.rawLabelMask);
        expect(manifest.frames.map(f => BigInt(f.pts)*BigInt(manifest.timeBase.num)*25n)).toEqual(
          Array.from({length:9},(_,i) => BigInt(i)*BigInt(manifest.timeBase.den)));
        const {stdout: rgb} = await execute("ffmpeg", ["-v","error","-i",source,"-frames:v","9","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],
          {encoding:"buffer",maxBuffer:4<<20});
        for (const [i, row] of manifest.frames.entries()) {
          const label = await cas.readBytes(row.label);
          let intersection=0, union=0;
          for (let pixel=0;pixel<label.length;pixel++) {
            const pos=(i*label.length+pixel)*3;
            const orange=rgb[pos]!>155 && rgb[pos+1]!>70 && rgb[pos+2]!<80;
            if (orange || label[pixel]) union++;
            if (orange && label[pixel]) intersection++;
          }
          expect(intersection/union).toBeGreaterThan(.90);
        }
        const reviewRequest = {projectId:job.projectId,jobId:job.jobId,expectedRevision:job.revision,
          manifestHash:artifact.blob.sha256,reviewHash:manifest.reviewVideo.sha256,requestId:"wrong-proxy"};
        await expect(invoke("request_tracked_mask_review", {...reviewRequest, reviewHash:"0".repeat(64)})).rejects.toThrow();
        await web("wait","--text","提交整段掩码审批");
        await clickDesk("提交整段掩码审批");
        await web("wait","--text","等待整段掩码审批");
        const approveButton = '[aria-label="批准整段掩码作为输入"]';
        expect(await web("eval",`document.querySelector('${approveButton}').getAttribute('aria-disabled')`)).toContain("true");
        await clickDesk("拒绝整段掩码");
        await web("wait","--text","整段掩码已拒绝");
        await clickDesk("重新提交整段掩码审批");
        await web("wait","--text","等待整段掩码审批");
        const pendingSequence = ProjectSnapshotSchema.parse(await invoke("get_project",{projectId:job.projectId})).approvals
          .find(a => a.subjectId===artifact.artifactId && a.status==="pending")!;
        expect(pendingSequence).toMatchObject({purpose:"input",subjectHash:artifact.blob.sha256});
        await expect(invoke("propose_vace_preview",{projectId:job.projectId,requestId:"pending-generation",expectedRevision:job.revision,
          maskApprovalId:pendingSequence.approvalId,manifestHash:artifact.blob.sha256,prompt:"blue",negativePrompt:"",seed:1})).rejects.toThrow();
        expect(await invoke("request_tracked_mask_review",{...reviewRequest,requestId:"same-input"})).toEqual(pendingSequence);
        await web("wait", "--text", "播放掩码传播审片");
        await clickDesk("播放掩码传播审片（9 帧/秒）");
        await web("wait", "--fn", "document.querySelector('video')?.readyState >= 2");
        expect(Number(await web("eval", "document.querySelector('video').duration"))).toBe(1);
        await web("eval", "(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); })()");
        await expect.poll(async () => Number(await web("eval", "document.querySelector('video').currentTime"))).toBeGreaterThan(0.25);
        await web("wait","--fn","document.querySelector('video').ended");
        const decision = {approvalId:pendingSequence.approvalId,expectedRevision:job.revision,decision:"approve",
          requestId:`approve-${pendingSequence.approvalId}`};
        for (const blob of [manifest.frames[7]!.label,manifest.reviewVideo]) {
          const file = cas.pathFor(blob);
          await rename(file,file+".offline");
          try {
            await expect(invoke("decide_approval",decision)).rejects.toThrow();
            const snapshot = ProjectSnapshotSchema.parse(await invoke("get_project",{projectId:job.projectId}));
            expect(snapshot.approvals.find(a=>a.approvalId===pendingSequence.approvalId)?.status).toBe("pending");
          } finally {await rename(file+".offline",file);}
        }
        await clickDesk("批准整段掩码作为输入");
        await web("wait","--text","整段掩码已批准");
        const decided = await invoke("decide_approval",decision);
        expect(decided).toEqual({approval:{...pendingSequence,status:"approved"}});
        const done = ProjectSnapshotSchema.parse(await invoke("get_project",{projectId:job.projectId}));
        expect(done.approvals.filter(a=>a.purpose==="input").map(a=>a.status).sort()).toEqual(["approved","approved","rejected"]);
        expect(done.jobs.filter(j=>!j.analysisAssetId).map(j=>j.jobId)).toEqual([job.jobId]);
        const ledger = new DatabaseSync(path.join(daemon.paseoHome,"video-editor","editor.sqlite"));
        try {
          const rows = ledger.prepare("SELECT r.decided_by, a.grant FROM tracked_mask_reviews r JOIN approvals a USING(approval_id) WHERE r.job_id = ? ORDER BY r.rowid").all(job.jobId);
          expect(rows).toEqual([{decided_by:"owner",grant:null},{decided_by:"owner",grant:null}]);
        } finally {ledger.close();}

        if (process.env.VIDEO_EDITOR_VACE_TEST === "1") {
          const snapshot=async()=>ProjectSnapshotSchema.parse(await invoke("get_project",{projectId:job.projectId}));
          const waitFor=async(kind:string,state:string,timeout:number)=>{
            await expect.poll(async()=>{
              const j=(await snapshot()).jobs.find(j=>j.kind===kind);
              return j?.state===state || j?.state==="failed";
            },{timeout,interval:800}).toBe(true);
            const j=(await snapshot()).jobs.find(j=>j.kind===kind)!;
            expect(j.state,JSON.stringify(j.error)).toBe(state);
            return j;
          };
          await web("fill",'[aria-label="VACE 提示词"]',"A cobalt blue ceramic rectangle moving right on a dark navy background, fixed camera.");
          await web("fill",'[aria-label="VACE 负面提示词"]',"orange, yellow, text");
          await clickDesk("提交 VACE 预览方案");
          await web("wait","--text","预览审批");
          const proposed=await snapshot();
          expect(proposed.jobs.filter(j=>j.kind!=="analysis")).toHaveLength(0);
          expect(proposed.plans[0]?.generationRequests[0]).toMatchObject({maskApprovalId:pendingSequence.approvalId,referenceManifestHash:artifact.blob.sha256});
          const moved = EditPlanDraftV1Schema.strip().parse(proposed.plans[0]);
          moved.trimOperations[0]!.sourceRange.start={num:"1",den:"25"};
          await expect(invoke("submit_plan",{requestId:"shifted-vace",runId:"shifted-vace",toolCallId:"shifted-vace",draft:moved})).rejects.toThrow();
          expect((await snapshot()).plans).toHaveLength(1);
          await clickDesk("批准并渲染预览");
          const preview=await waitFor("preview","awaiting_review",300000);
          const qa=JSON.parse((await cas.readBytes(preview.artifacts.find(a=>a.kind==="qa")!.blob)).toString());
          expect(qa.generation.modelRun).toMatchObject({seed:732021,steps:20,manifestHash:artifact.blob.sha256});
          expect(qa.generation.modelRun.protectedPixels).toEqual(manifest.frames.map(f=>320*192-f.foregroundPixels));
          await clickDesk("刷新项目");
          await clickDesk("观看预览候选");
          const selector='video[aria-label="观看预览候选"]';
          await web("wait",selector);
          await web("eval",`(async()=>{const v=document.querySelector('${selector}');v.muted=true;await v.play()})()`);
          await web("wait","--fn",`document.querySelector('${selector}').ended`);
          await clickDesk("批准渲染成品候选");
          const final=await waitFor("final","awaiting_delivery_approval",20000);
          expect(final.artifacts.find(a=>a.kind==="candidate")?.blob).toEqual(qa.generation.master);
          await clickDesk("刷新项目");
          await clickDesk("观看成品审片代理");
          await web("wait",'video[aria-label="观看成品审片代理"]');
          await clickDesk("确认审片并批准导出");
          const exported=await waitFor("export","completed",20000);
          const delivery=exported.artifacts.find(a=>a.kind==="export")!;
          expect(delivery.blob).toEqual(qa.generation.master);
          const recipe=JSON.parse((await cas.readBytes(exported.artifacts.find(a=>a.kind==="manifest")!.blob)).toString());
          expect(recipe.modelRuns).toEqual([qa.generation.modelRun]);
          expect(recipe.maskLineageRoots).toEqual([artifact.blob.sha256]);
          const media=cas.pathFor(delivery.blob);
          const {stdout:decoded}=await execute("ffmpeg",["-v","error","-i",media,"-map","0:v:0","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{encoding:"buffer",maxBuffer:4<<20});
          expect(decoded.length).toBe(rgb.length);
          const refAudio=path.join(root,"source-audio.m4a");
          await execute("ffmpeg",["-v","error","-i",source,"-map","0:a:0","-af","atrim=start=0:duration=0.36,asetpts=PTS-STARTPTS,aresample=48000","-c:a","aac",refAudio]);
          const pcm=async(file:string)=>(await execute("ffmpeg",["-v","error","-i",file,"-map","0:a:0","-f","s16le","pipe:1"],{encoding:"buffer"})).stdout;
          const originalAudio=await pcm(refAudio);
          expect(originalAudio.byteLength).toBeGreaterThan(30000);
          expect(await pcm(media)).toEqual(originalAudio);

          let outside=0,inside=0,insidePixels=0;
          for (const [i,row] of manifest.frames.entries()) {
            const label=await cas.readBytes(row.label);
            for (const [j,v] of label.entries()) {
              const pos=(i*label.length+j)*3;
              const error=[0,1,2].reduce((s,c)=>s+Math.abs(decoded[pos+c]!-rgb[pos+c]!),0)/3;
              if (v) {inside+=error;insidePixels++;} else outside+=error;
            }
          }
          expect(inside/insidePixels).toBeGreaterThan(15);
          expect(outside/(rgb.length/3-insidePixels)).toBeLessThan(4);
        }


        expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(digest);
        return;
      }
      if (silenceCut) {
        await clickDesk("分析切点/波形");
        await web("wait", "--text", "场景切点");
        await web("fill", '[aria-label="素材总长（秒）"]', "2.28");
        await web("fill", '[aria-label="删除起点（秒）"]', "0");
        await web("fill", '[aria-label="删除终点（秒）"]', "0.55");
        await clickDesk("静音挖洞");
        await web("wait", "--text", "所选区间内没有连续至少");
        const untouched = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(untouched.plans).toHaveLength(0);
        await web("fill", '[aria-label="删除起点（秒）"]', "0.550");
        await web("fill", '[aria-label="删除终点（秒）"]', "1.650");
        await clickDesk("静音挖洞");
        await web("wait", "--text", "0.600s–1.600s");
      } else {
        // This range is exact on the 25 fps source, but not representable on a 30 fps grid.
        await web("fill", '[aria-label="入点（秒，含）"]', "0.120");
        await web("fill", '[aria-label="出点（秒，不含）"]', "1.400");
        await web("eval", `[...document.querySelectorAll('[role="button"],button')]
          .find(node => node.textContent.includes('提交裁剪方案'))
          ?.scrollIntoView({block: 'center', inline: 'center'});`);
        await web("find", "role", "button", "click", "--name", "提交裁剪方案");
        await web("wait", "--text", "保留 镜头 A.mp4");
        const tree = await web("snapshot");
        expect(tree).toContain("120/1000");
        expect(tree).toContain("1280/1000");
      }
      const saved = ProjectSnapshotSchema.parse(
        await invoke("get_project", { projectId: project.projectId }),
      );
      expect(saved.plans).toHaveLength(1);
      expect(saved.approvals[0]?.status).toBe("pending");
      expect(saved.jobs.filter(j => !j.analysisAssetId)).toHaveLength(0);
      if (silenceCut) {
        expect(saved.plans[0]?.trimOperations.map(op => op.sourceRange)).toEqual([
          { start: { num: "0", den: "1000" }, duration: { num: "600", den: "1000" } },
          { start: { num: "1600", den: "1000" }, duration: { num: "680", den: "1000" } },
        ]);
      } else {
        expect(saved.plans[0]?.trimOperations[0]?.sourceRange).toEqual({
          start: { num: "120", den: "1000" },
          duration: { num: "1280", den: "1000" },
        });
      }
      if (scenario === "reject preview") {
        await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>n.textContent==='拒绝预览方案')?.scrollIntoView({block:'center'}); true`);
        await web("find", "role", "button", "click", "--name", "拒绝预览方案");
        await web("wait", "--text", "已拒绝预览");
        const rejected = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(rejected.approvals).toHaveLength(1);
        expect(rejected.approvals[0]).toMatchObject({approvalId:saved.approvals[0]?.approvalId, status:"rejected"});
        expect(rejected.jobs.filter(j => !j.analysisAssetId)).toHaveLength(0);
        expect(rejected.revision).toBe(saved.revision);
        return;
      }
      // Observe the trusted pointer event before React handles it. A semantic locator can resolve
      // an off-screen control even when the physical click lands on its scroll container.
      await web(
        "eval",
        `document.addEventListener('click', event => {
        const control = [...document.querySelectorAll('[role="button"],button')]
          .find(node => node.textContent === '批准并渲染预览');
        const rect = control?.getBoundingClientRect();
        const scrollers = [];
        for (let node = control?.parentElement; node; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight) scrollers.push([node.tagName, node.clientHeight, node.scrollHeight, node.scrollTop]);
        }
        window.approvalHit = {matched: event.isTrusted && control?.contains(event.target),
          target: event.target.tagName, pointer: [event.clientX,event.clientY], rect: rect?.toJSON(),
          viewport: [innerWidth,innerHeight], scrollers,
          centerHit: rect && document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.tagName};
      }, {capture:true,once:true}); true`,
      );
      // The semantic locator resolves the control below the fold; scroll it into the viewport
      // first so the physical pointer lands on the control instead of the scroll container.
      await web(
        "eval",
        `[...document.querySelectorAll('[role="button"],button')]
        .find(node => node.textContent === '批准并渲染预览')
        ?.scrollIntoView({block: 'center', inline: 'center'});`,
      );
      await web("find", "role", "button", "click", "--name", "批准并渲染预览");
      const hit = await web("eval", "window.approvalHit ?? null");
      expect(JSON.parse(hit), hit).toMatchObject({ matched: true });
      await expect
        .poll(
          async () =>
            ProjectSnapshotSchema.parse(
              await invoke("get_project", { projectId: project.projectId }),
            ).jobs.find(j => j.kind === "preview")?.state,
          { timeout: 10000 },
        )
        .toBe("awaiting_review");
      await web("eval", `[...document.querySelectorAll('[role="button"],button')]
        .find(node => node.textContent === '刷新项目')
        ?.scrollIntoView({block: 'center', inline: 'center'});`);
      await web("find", "role", "button", "click", "--name", "刷新项目");
      await web("wait", "--text", "等待审片");
      await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>n.textContent==='观看预览候选')?.scrollIntoView({block:'center'}); true`);
      await web("find", "role", "button", "click", "--name", "观看预览候选");
      const video = 'video[aria-label="观看预览候选"]';
      await web("wait", video);
      await expect.poll(async () => JSON.parse(await web("eval", `(()=>{const v=document.querySelector('${video}');return [v.videoWidth,v.videoHeight,Math.round(v.duration*1000)]})()`)), {timeout:10000}).toEqual([640,360,1280]);
      const reviewed = ProjectSnapshotSchema.parse(
        await invoke("get_project", { projectId: project.projectId }),
      );
      expect(reviewed.jobs.filter(j => !j.analysisAssetId)).toHaveLength(1);
      const finalApproval = reviewed.approvals.find((a) => a.purpose === "final");
      expect(finalApproval?.status).toBe("pending");
      await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>n.textContent==='批准渲染成品候选')?.scrollIntoView({block:'center'}); true`);
      await web("find", "role", "button", "click", "--name", "批准渲染成品候选");
      await expect.poll(async () => {
        const current = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: project.projectId }));
        return current.jobs.find(j => j.kind === "final")?.state;
      }, { timeout: 15000 }).toBe("awaiting_delivery_approval");
      const finalReady = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: project.projectId }));
      expect(finalReady.jobs.filter(j => !j.analysisAssetId)).toHaveLength(2);
      expect(finalReady.jobs.find(j => j.kind === "final")?.approvalId).toBe(finalApproval?.approvalId);
      const exportApproval = finalReady.approvals.find(a => a.purpose === "export");
      expect(exportApproval?.status).toBe("pending");
      await clickDesk("刷新项目");
      await clickDesk("观看成品审片代理");
      const finalVideo = 'video[aria-label="观看成品审片代理"]';
      await web("wait", finalVideo);
      await expect.poll(async () => JSON.parse(await web("eval", `(()=>{const v=document.querySelector('${finalVideo}');return [v.videoWidth,v.videoHeight,Math.round(v.duration*1000)]})()`))).toEqual([640,360,1280]);
      await web("eval", `(async () => {
        const video = document.querySelector('${finalVideo}');
        video.muted = true;
        await video.play();
      })()`);
      await expect.poll(async () => Number(await web("eval",
        `document.querySelector('${finalVideo}').currentTime`))).toBeGreaterThan(0);
      const beforeExport = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
      expect(beforeExport.jobs.filter(j => !j.analysisAssetId)).toHaveLength(2);
      expect(beforeExport.approvals.find(a => a.purpose === "export")?.status).toBe("pending");
      await clickDesk("确认审片并批准导出");
      await expect.poll(async () => ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId})).jobs.find(j => j.kind === "export")?.state, {timeout: 15000}).toBe("completed");
      await clickDesk("刷新项目");
      await clickDesk("准备下载成品视频");
      const link = 'a[download$=".mp4"]';
      await web("wait", link);
      const downloaded = path.join(root, "reviewed.mp4");
      await web("download", link, downloaded);
      expect(createHash("sha256").update(await readFile(downloaded)).digest("hex")).toBe(exportApproval?.subjectHash);
      await execute("ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-i", downloaded, "-map", "0", "-f", "null", "-"], {timeout:30000});
      const probe = await execute("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json", downloaded]);
      expect(JSON.parse(probe.stdout).streams).toMatchObject([
        { codec_name: "h264", width: 160, height: 90, start_pts: 0, nb_read_frames: "32", duration: "1.280000" },
        { codec_name: "aac", start_pts: 0, time_base: "1/48000", duration_ts: 61440 },
      ]);
      if (silenceCut) {
        const pcm = (await execute("ffmpeg", [
          "-v", "error", "-i", downloaded, "-map", "0:a:0", "-ar", "48000", "-ac", "1", "-f", "s16le", "pipe:1",
        ], { encoding: "buffer" })).stdout;
        // Each 100 ms window contains 44 or 88 positive-going zero crossings.
        for (const [offset, expected] of [[9600, 44], [43200, 88]] as const) {
          let crossings = 0;
          for (let i = offset; i < offset + 4800; i++)
            if (pcm.readInt16LE(2*i) <= 0 && pcm.readInt16LE(2*i+2) > 0) crossings++;
          expect(Math.abs(crossings - expected)).toBeLessThanOrEqual(1);
        }
      }
      await clickDesk("准备下载导出清单");
      const manifestLink = 'a[download$=".json"]';
      await web("wait", manifestLink);
      const manifestFile = path.join(root, "manifest.json");
      await web("download", manifestLink, manifestFile);
      expect(JSON.parse(await readFile(manifestFile, "utf8"))).toMatchObject({
        output: { sha256: exportApproval?.subjectHash },
        planHash: exportApproval?.planHash,
        revision: exportApproval?.subjectRevision,
        approvalId: exportApproval?.approvalId,
      });
      expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(digest);
    } finally {
      try {
        await web("close").catch(() => undefined);
        await owner.close();
        await daemon.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  process.env.VIDEO_EDITOR_VACE_TEST === "1" ? 420000 : process.env.VIDEO_EDITOR_LIVE_PLANNER === "1" ? 210000 : 120000,
);
