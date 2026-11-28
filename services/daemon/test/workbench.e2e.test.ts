import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { makePeopleClip, recordedWorker } from "./recorded-object-worker.js";
import { AveDaemon } from "../src/index.js";

it("creates a project and reviews a recorded object removal in the built Chromium workbench", async () => {
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
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  } finally {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
