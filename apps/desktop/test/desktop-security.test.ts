import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AveClient } from "@ave/client-sdk";
import {
  ALLOWED_IPC_CHANNELS,
  buildDesktopWindowOptions,
  isAllowedIpcChannel,
  launchDesktopDaemon,
  registerDesktopBridge,
  type LaunchedDaemon,
} from "../src/index.js";

const tempDirs: string[] = [];
const daemons: LaunchedDaemon[] = [];

afterEach(async () => {
  while (daemons.length) {
    await daemons.pop()!.stop().catch(() => {});
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("@ave/desktop security & daemon launcher", () => {
  it("enforces contextIsolation=true, nodeIntegration=false, sandbox=true and narrow IPC bridge", async () => {
    const opts = buildDesktopWindowOptions("/tmp/preload.js");
    expect(opts.webPreferences.contextIsolation).toBe(true);
    expect(opts.webPreferences.nodeIntegration).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.webSecurity).toBe(true);
    expect(opts.webPreferences.allowRunningInsecureContent).toBe(false);

    expect(isAllowedIpcChannel("ave:get-daemon-config")).toBe(true);
    expect(isAllowedIpcChannel("ave:pick-source-file")).toBe(true);
    expect(isAllowedIpcChannel("ave:exec-shell")).toBe(false);
    expect(ALLOWED_IPC_CHANNELS).toHaveLength(2);

    const exposed: Record<string, Record<string, () => Promise<unknown>>> = {};
    const invoked: string[] = [];
    registerDesktopBridge(
      {
        exposeInMainWorld: (key, api) => {
          exposed[key] = api as Record<string, () => Promise<unknown>>;
        },
      },
      {
        invoke: async (channel) => {
          invoked.push(channel);
          return { ok: true };
        },
      },
    );
    await exposed.aveDesktop!.getDaemonConfig!();
    await exposed.aveDesktop!.pickSourceFile!();
    expect(invoked).toEqual(["ave:get-daemon-config", "ave:pick-source-file"]);
  });

  it("spawns real native AVE daemon child process on isolated AVE_HOME and answers WebSocket RPC", async () => {
    const aveHome = await mkdtemp(path.join(os.tmpdir(), "ave-desktop-home-"));
    tempDirs.push(aveHome);

    const daemon = await launchDesktopDaemon({ aveHome });
    daemons.push(daemon);
    expect(daemon.pid).toBeGreaterThan(0);
    expect(daemon.aveHome).toBe(aveHome);

    const res = await fetch(daemon.healthUrl);
    expect(res.ok).toBe(true);

    const client = new AveClient({
      url: daemon.wsUrl,
      auth: { kind: "localOwner", token: daemon.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    const principal = await client.connect();
    expect(principal.role).toBe("owner");
    const caps = await client.getCapabilities();
    expect(caps.features).toContain("deterministic-editing");

    client.close();
    await daemon.stop();
  }, 20_000);
});
