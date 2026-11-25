import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, test } from "vitest";
import { encodeFramedChunk } from "#video-editor/bytes";
import { ProjectSnapshotSchema, UploadStatusSchema } from "#video-editor/contracts/v1";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, builtinPlugins } from "../plugins/builtin/index.js";

const execute = promisify(execFile);
const repo = fileURLToPath(new URL("../../../../../", import.meta.url));

// Opt-in: requires agent-browser and a local Chrome binary. Never attaches to a user's browser.
test
  .skipIf(process.env.VIDEO_EDITOR_BROWSER_TEST !== "1")
  .each(["source import", "preview approval and reviewed delivery", "reject preview", "project creation and discovery"] as const)(
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
          "testsrc2=size=160x90:rate=25:duration=2",
          "-c:v",
          "libx264",
          source,
        ],
        { timeout: 30000 },
      );
      const bytes = await readFile(source);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (scenario !== "source import" && scenario !== "project creation and discovery") {
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
      plugin.default({addScreen:({Component})=>Screen=Component,addSidebarHeaderItem:()=>{}});
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
        return;
      }
      await web("wait", '[aria-label="入点（秒，含）"]');
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
      const clickDesk = async (label: string) => {
        await web("eval", `[...document.querySelectorAll('[role="button"],button')].find(n=>n.textContent===${JSON.stringify(label)})?.scrollIntoView({block:'center'}); true`);
        await web("find", "role", "button", "click", "--name", label);
      };
      await clickDesk("刷新项目");
      await clickDesk("观看成品审片代理");
      const finalVideo = 'video[aria-label="观看成品审片代理"]';
      await web("wait", finalVideo);
      await expect.poll(async () => JSON.parse(await web("eval", `(()=>{const v=document.querySelector('${finalVideo}');return [v.videoWidth,v.videoHeight,Math.round(v.duration*1000)]})()`))).toEqual([640,360,1280]);
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
