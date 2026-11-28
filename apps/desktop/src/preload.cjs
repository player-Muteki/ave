// Sandboxed Electron preload scripts run as classic scripts with a CommonJS bridge.
/**
 * @param {{ exposeInMainWorld(key: string, api: unknown): void }} contextBridge
 * @param {{ invoke(channel: string, input?:unknown): Promise<unknown> }} ipcRenderer
 */
function registerDesktopBridge(contextBridge, ipcRenderer) {
  contextBridge.exposeInMainWorld("aveDesktop", {
    getDaemonConfig: () => ipcRenderer.invoke("ave:get-daemon-config"),
    accountStatus: () => ipcRenderer.invoke("ave:account-status"),
    accountLogin: () => ipcRenderer.invoke("ave:account-login"),
    accountCancel: () => ipcRenderer.invoke("ave:account-cancel"),
    accountLogout: () => ipcRenderer.invoke("ave:account-logout"),
    accountModels: () => ipcRenderer.invoke("ave:account-models"),
    accountUsage: () => ipcRenderer.invoke("ave:account-usage"),
    accountPlan: (/** @type {unknown} */ input) => ipcRenderer.invoke("ave:account-plan", input),
    pickSourceFile: () => ipcRenderer.invoke("ave:pick-source-file"),
  });
}

if (typeof exports !== "undefined") exports.registerDesktopBridge = registerDesktopBridge;
if (/** @type {{type?: string}} */ (process).type === "renderer") {
  const electronModule = "electron";
  const { contextBridge, ipcRenderer } = require(electronModule);
  registerDesktopBridge(contextBridge, ipcRenderer);
}
