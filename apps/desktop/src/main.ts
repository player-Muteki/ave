import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchDesktopDaemon } from "./daemon-launcher.js";
import { buildDesktopWindowOptions, isAllowedIpcChannel } from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startElectronDesktopApp(): Promise<void> {
  const electronModuleName = "electron";
  const electron = (await import(electronModuleName)) as {
    app: {
      whenReady(): Promise<void>;
      on(event: string, listener: () => void): void;
      quit(): void;
      getPath(name: string): string;
    };
    BrowserWindow: new (options: ReturnType<typeof buildDesktopWindowOptions>) => {
      loadFile(filePath: string): Promise<void>;
    };
    ipcMain: {
      handle(channel: string, listener: () => Promise<unknown>): void;
    };
    dialog: {
      showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
    };
  };

  await electron.app.whenReady();
  const aveHome = path.join(electron.app.getPath("userData"), "ave-home");
  const daemon = await launchDesktopDaemon({ aveHome });

  const registerSafe = (channel: string, handler: () => Promise<unknown>) => {
    if (!isAllowedIpcChannel(channel)) {
      throw new Error(`Disallowed IPC channel: ${channel}`);
    }
    electron.ipcMain.handle(channel, handler);
  };

  registerSafe("ave:get-daemon-config", async () => ({
    wsUrl: daemon.wsUrl,
    ownerToken: daemon.ownerToken,
    aveHome: daemon.aveHome,
  }));

  registerSafe("ave:pick-source-file", async () => {
    const res = await electron.dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Video", extensions: ["mp4", "mov", "mkv", "webm"] }],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  const preloadPath = path.join(__dirname, "preload.cjs");
  const win = new electron.BrowserWindow(buildDesktopWindowOptions(preloadPath));
  const webHtml = path.resolve(__dirname, "../../web/dist/browser/index.html");
  await win.loadFile(webHtml);

  electron.app.on("window-all-closed", () => {
    void daemon.stop().finally(() => electron.app.quit());
  });
}

if (process.versions?.electron) {
  void startElectronDesktopApp();
}
