export const ALLOWED_IPC_CHANNELS = [
  "ave:get-daemon-config",
  "ave:pick-source-file",
  "ave:account-status",
  "ave:account-login",
  "ave:account-cancel",
  "ave:account-logout",
  "ave:account-models",
  "ave:account-usage",
  "ave:account-plan",

] as const;

export type AllowedIpcChannel = (typeof ALLOWED_IPC_CHANNELS)[number];

export interface DesktopWindowOptions {
  width: number;
  height: number;
  webPreferences: {
    preload: string;
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    webSecurity: true;
    allowRunningInsecureContent: false;
  };
}

export function buildDesktopWindowOptions(preloadPath: string): DesktopWindowOptions {
  return {
    width: 1280,
    height: 820,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

export function isAllowedIpcChannel(channel: string): channel is AllowedIpcChannel {
  return (ALLOWED_IPC_CHANNELS as readonly string[]).includes(channel);
}
