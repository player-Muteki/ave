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
import { TrackedMaskManifestSchema, MaskAnchorRevisionSchema, ProjectSnapshotSchema, UploadStatusSchema } from "#video-editor/contracts/v1";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { ContentAddressedStore } from "./cas.js";
import { BuiltinPluginLoader, builtinPlugins } from "../plugins/builtin/index.js";

const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../../../../../", import.meta.url));

// Opt-in: requires agent-browser and a local Chrome binary. Never attaches to a user's browser.
test
  .skipIf(process.env.VIDEO_EDITOR_BROWSER_TEST !== "1")
  .each(["source import", "preview approval and reviewed delivery", "reject preview",
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
      const source = path.join(root, "clip.mp4");
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
      const bytes = await readFile(source);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (scenario !== "source import") {
        const upload = UploadStatusSchema.parse(
          await invoke("create_upload", {
            projectId: project.projectId,
            requestId: "upload",
            displayName: "镜头 A.mp4",
            expectedSize: String(bytes.length),
            expectedSha256: digest,
            mediaType: "video/mp4",
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
      await web("fill", '[aria-label="项目 ID"]', project.projectId);
      await web("find", "role", "button", "click", "--name", "打开项目");
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
        expect(imported.jobs).toHaveLength(0);
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
        expect(saved.jobs).toHaveLength(0);
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
        expect(approved.jobs).toHaveLength(0);
        expect(approved.approvals).toHaveLength(1);
        expect(approved.approvals[0]).toMatchObject({status: "approved", purpose: "input", subjectHash: approval!.subjectHash});
        await expect(invoke("track_mask", {...track, firstFrame: 5, requestId:"outside-anchor"})).rejects.toThrow();
        await clickDesk("传播已批准的掩码");
        await expect.poll(async () => {
          const p = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
          if (p.jobs[0]?.state === "failed") throw Error(JSON.stringify(p.jobs[0].error));
          return p.jobs[0]?.state;
        }, {timeout: 45000}).toBe("completed");
        const finished = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(finished.approvals).toHaveLength(1);
        const job = finished.jobs[0]!;
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
        await web("wait", "--text", "播放掩码传播审片");
        await clickDesk("播放掩码传播审片（9 帧/秒）");
        await web("wait", "--fn", "document.querySelector('video')?.readyState >= 2");
        expect(Number(await web("eval", "document.querySelector('video').duration"))).toBe(1);
        await web("eval", "(async () => { const v = document.querySelector('video'); v.muted = true; await v.play(); })()");
        await expect.poll(async () => Number(await web("eval", "document.querySelector('video').currentTime"))).toBeGreaterThan(0.25);
        expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(digest);
        return;
      }
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
      const saved = ProjectSnapshotSchema.parse(
        await invoke("get_project", { projectId: project.projectId }),
      );
      expect(saved.plans).toHaveLength(1);
      expect(saved.approvals[0]?.status).toBe("pending");
      expect(saved.jobs).toHaveLength(0);
      expect(saved.plans[0]?.trimOperations[0]?.sourceRange).toEqual({
        start: { num: "120", den: "1000" },
        duration: { num: "1280", den: "1000" },
      });
      if (scenario === "reject preview") {
        await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>n.textContent==='拒绝预览方案')?.scrollIntoView({block:'center'}); true`);
        await web("find", "role", "button", "click", "--name", "拒绝预览方案");
        await web("wait", "--text", "已拒绝预览");
        const rejected = ProjectSnapshotSchema.parse(await invoke("get_project", {projectId: project.projectId}));
        expect(rejected.approvals).toHaveLength(1);
        expect(rejected.approvals[0]).toMatchObject({approvalId:saved.approvals[0]?.approvalId, status:"rejected"});
        expect(rejected.jobs).toHaveLength(0);
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
            ).jobs[0]?.state,
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
      expect(reviewed.jobs).toHaveLength(1);
      const finalApproval = reviewed.approvals.find((a) => a.purpose === "final");
      expect(finalApproval?.status).toBe("pending");
      await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>n.textContent==='批准渲染成品候选')?.scrollIntoView({block:'center'}); true`);
      await web("find", "role", "button", "click", "--name", "批准渲染成品候选");
      await expect.poll(async () => {
        const current = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: project.projectId }));
        return current.jobs.find(j => j.kind === "final")?.state;
      }, { timeout: 15000 }).toBe("awaiting_delivery_approval");
      const finalReady = ProjectSnapshotSchema.parse(await invoke("get_project", { projectId: project.projectId }));
      expect(finalReady.jobs).toHaveLength(2);
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
      expect(beforeExport.jobs).toHaveLength(2);
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
  120000,
);
