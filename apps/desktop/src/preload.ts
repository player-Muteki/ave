// Electron preload script running with contextIsolation: true and sandbox: true.
// Exposes only narrow, allow-listed IPC bridges to the renderer.

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

interface ContextBridgeLike {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

export function registerDesktopBridge(
  contextBridge: ContextBridgeLike,
  ipcRenderer: IpcRendererLike,
): void {
  contextBridge.exposeInMainWorld("aveDesktop", {
    getDaemonConfig: () => ipcRenderer.invoke("ave:get-daemon-config"),
    pickSourceFile: () => ipcRenderer.invoke("ave:pick-source-file"),
  });
}

// Auto-register when executed directly inside Electron preload context
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as {
    contextBridge?: ContextBridgeLike;
    ipcRenderer?: IpcRendererLike;
  };
  if (electron?.contextBridge && electron?.ipcRenderer) {
    registerDesktopBridge(electron.contextBridge, electron.ipcRenderer);
  }
} catch {
  // Not running inside Electron runtime (e.g. unit test / tsc build)
}
