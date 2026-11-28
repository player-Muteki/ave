import path from "node:path";
import { StartPlanningRunInputSchema } from "@ave/contracts";
import { ChatGptAccount, type SecretStorage } from "./chatgpt-account.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchDesktopDaemon } from "./daemon-launcher.js";
import { buildDesktopWindowOptions, isAllowedIpcChannel } from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startElectronDesktopApp(): Promise<void> {
  const electronModuleName = "electron";
  const electron = (await import(electronModuleName)) as {
    app: {
      requestSingleInstanceLock(): boolean;
      whenReady(): Promise<void>;
      on(event: string, listener: () => void): void;
      quit(): void;
      getPath(name: string): string;
    };
    safeStorage: SecretStorage;
    shell: { openExternal(url: string): Promise<void> };
    BrowserWindow: new (
      options: ReturnType<typeof buildDesktopWindowOptions>,
    ) => {
      webContents: {
        mainFrame: unknown;
        setWindowOpenHandler(handler: () => { action: "deny" }): void;
      };
      loadFile(filePath: string): Promise<void>;
    };
    ipcMain: {
      handle(
        channel: string,
        listener: (
          event: { sender: unknown; senderFrame?: { url: string } },
          input?: unknown,
        ) => Promise<unknown>,
      ): void;
    };
    dialog: {
      showOpenDialog(
        options: Record<string, unknown>,
      ): Promise<{ canceled: boolean; filePaths: string[] }>;
    };
  };

  if (!electron.app.requestSingleInstanceLock()) {
    electron.app.quit();
    return;
  }
  await electron.app.whenReady();
  const aveHome = path.join(electron.app.getPath("userData"), "ave-home");
  const daemon = await launchDesktopDaemon({ aveHome });

  const preloadPath = path.join(__dirname, "preload.cjs");
  const win = new electron.BrowserWindow(
    buildDesktopWindowOptions(preloadPath),
  );
  const webHtml = path.resolve(__dirname, "../../web/dist/browser/index.html");
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const account = new ChatGptAccount(
    path.join(electron.app.getPath("userData"), "chatgpt"),
    electron.safeStorage,
    (url) => electron.shell.openExternal(url),
  );
  const registerSafe = (
    channel: string,
    handler: (input?: unknown) => Promise<unknown>,
  ) => {
    if (!isAllowedIpcChannel(channel)) {
      throw new Error(`Disallowed IPC channel: ${channel}`);
    }
    electron.ipcMain.handle(channel, async (event, input) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame?.url !== pathToFileURL(webHtml).href
      )
        throw new Error("无效的桌面请求来源");
      return handler(input);
    });
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

  registerSafe("ave:account-status", async () => account.status());
  registerSafe("ave:account-login", async () => account.login());
  registerSafe("ave:account-cancel", async () => account.cancel());
  registerSafe("ave:account-logout", async () => {
    daemon.cancelChatGpt();
    await account.logout();
  });
  registerSafe("ave:account-models", async () => account.models());
  registerSafe("ave:account-usage", async () =>
    electron.shell.openExternal("https://chatgpt.com/settings/usage"),
  );
  registerSafe("ave:account-plan", async (raw) => {
    const input = StartPlanningRunInputSchema.parse(raw);
    if (input.model?.provider !== "chatgpt")
      throw new Error("请选择 ChatGPT 模型");
    const version = account.sessionVersion;
    return daemon.startChatGpt(input, async () => {
      if (version !== account.sessionVersion) throw new Error("账号已变更");
      return account.access();
    });
  });
  await win.loadFile(webHtml);

  electron.app.on("window-all-closed", () => {
    void daemon.stop().finally(() => electron.app.quit());
  });
}

if (process.versions?.electron) {
  void startElectronDesktopApp();
}
