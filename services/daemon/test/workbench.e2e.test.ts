import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { expect, it } from "vitest";
import { makePeopleClip, recordedWorker } from "./recorded-object-worker.js";
import { AveDaemon } from "../src/index.js";

async function withWorkbench(run: (page: Page, home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "ave-browser-"));
  const daemon = await AveDaemon.create({ aveHome: home, mediaWorkerTestAdapter: recordedWorker() });
  try {
    const address = await daemon.start();
    const executablePath = process.env.AVE_TEST_CHROMIUM ?? [
      chromium.executablePath(), "/usr/lib/chromium/chromium", "/opt/google/chrome/chrome",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].find(existsSync);
    const browser = await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      const url = pathToFileURL(path.resolve("apps/web/dist/browser/index.html"));
      url.searchParams.set("wsUrl", address.wsUrl);
      url.searchParams.set("token", address.ownerToken);
      await page.goto(url.href);
      await page.getByText(/● 已连接/).waitFor();
      await page.getByRole("textbox", { name: "项目名称" }).fill("浏览器回归");
      await page.getByRole("button", { name: "新建项目" }).click();
      await page.getByRole("button", { name: /浏览器回归/ }).waitFor();
      expect(daemon.store.projects.listProjects({ principalId: "owner", role: "owner", projectIds: null })[0]?.title).toBe("浏览器回归");
      await run(page, home);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  } finally {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
}

it("creates a project and reviews a recorded object removal in the built Chromium workbench", async () => {
  await withWorkbench(async (page, home) => {
    const clip = await makePeopleClip(home);
    await page.locator('input[type="file"]').setInputFiles(clip);
    await page.getByRole("button", { name: /two-people.mp4/ }).waitFor();
    await page.getByRole("button", { name: "新建去人/对象编辑" }).click();
    await page.getByRole("combobox", { name: "人物 1" }).selectOption("remove");
    await page.getByRole("combobox", { name: "人物 2" }).selectOption("keep");
    await page.getByRole("img", { name: "人物候选证据帧" }).first().waitFor();
    await page.getByRole("button", { name: "提交人物选择" }).click();
    await page.getByRole("img", { name: "待审核的掩码叠加图" }).waitFor();
    await page.getByRole("button", { name: "驳回并重新生成掩码" }).click();
    await page.getByRole("button", { name: "批准掩码", exact: true }).click();
    await page.getByRole("button", { name: "追踪九帧掩码" }).click();
    await page.getByLabel("追踪掩码审片").waitFor();
    await page.getByRole("button", { name: "申请整段掩码审批" }).click();
    await page.getByRole("button", { name: "批准整段掩码" }).click();
    await page.getByRole("button", { name: "提交生成方案" }).click();
    await page.getByRole("button", { name: "批准并执行" }).click();
    await page.getByText(/awaiting_review/).waitFor();
  });
}, 60_000);

it("previews an imported NTSC clip and submits the default two-second trim for review", async () => {
  await withWorkbench(async (page, home) => {
    const clip = path.join(home, "ntsc.mp4");
    await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=30000/1001",
      "-f", "lavfi", "-i", "sine=sample_rate=44100", "-t", "3", "-c:v", "libx264", "-c:a", "aac", clip]);
    await page.locator('input[type="file"]').setInputFiles(clip);
    await page.getByText("已导入 ntsc.mp4", { exact: true }).waitFor();
    const source = page.getByLabel("素材预览");
    await source.evaluate(async node => {
      const video = node as HTMLVideoElement;
      video.muted = true;
      await video.play();
    });
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('video[aria-label="素材预览"]');
      return video && video.videoWidth === 160 && video.currentTime > 0;
    });
    await page.reload();
    await page.getByRole("button", { name: /ntsc\.mp4/ }).waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('video[aria-label="素材预览"]')?.videoWidth === 160);
    await page.getByRole("button", { name: "提交裁剪方案" }).click();
    await page.getByText(/实际时长 2\.002 秒/).waitFor();
    await page.getByRole("button", { name: "批准并执行" }).click();
    await page.getByText(/awaiting_review/).waitFor();
    await page.getByRole("button", { name: "校验并加载成片" }).click();
    await page.waitForFunction(() => {
      const video = document.querySelector<HTMLVideoElement>('video[controls]:not([aria-label="素材预览"])');
      return video && video.videoWidth === 640 && video.videoHeight === 360 && Math.abs(video.duration - 2.002) < 0.001;
    });
    await page.getByLabel("时长秒数").fill("0.034");
    await page.getByRole("button", { name: "提交裁剪方案" }).click();
    await page.getByText(/实际时长 0\.033367 秒/).waitFor();
    const previewApproval = page.getByText(/^preview · pending ·/).locator("..");
    await previewApproval.getByRole("button", { name: "批准并执行" }).click();
    await page.getByText(/awaiting_review/).nth(1).waitFor();
  });
}, 60_000);
