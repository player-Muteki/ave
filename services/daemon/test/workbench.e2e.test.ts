import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { AveDaemon } from "../src/index.js";

it("opens the built workbench and creates a persisted project over WebSocket", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ave-browser-"));
  const daemon = await AveDaemon.create({ aveHome: home });
  try {
    const address = await daemon.start();
    const executablePath = process.env.AVE_TEST_CHROMIUM ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "chrome" });
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
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  } finally {
    await daemon.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
