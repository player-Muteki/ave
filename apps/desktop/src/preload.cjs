// Sandboxed Electron preload scripts run as classic scripts with a CommonJS bridge.
/**
 * @param {{ exposeInMainWorld(key: string, api: unknown): void }} contextBridge
 * @param {{ invoke(channel: string): Promise<unknown> }} ipcRenderer
 */
function registerDesktopBridge(contextBridge, ipcRenderer) {
  contextBridge.exposeInMainWorld("aveDesktop", {
    getDaemonConfig: () => ipcRenderer.invoke("ave:get-daemon-config"),
    pickSourceFile: () => ipcRenderer.invoke("ave:pick-source-file"),
  });
}

exports.registerDesktopBridge = registerDesktopBridge;
if (/** @type {{type?: string}} */ (process).type === "renderer") {
  const electronModule = "electron";
  const { contextBridge, ipcRenderer } = require(electronModule);
  registerDesktopBridge(contextBridge, ipcRenderer);
}
