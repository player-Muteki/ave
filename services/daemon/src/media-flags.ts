import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const fpsModeSupport = new Map<string, Promise<boolean>>();

export type FfmpegOutputTimingMode = "vfr" | "passthrough";

/** Feature detection keeps the daemon usable with both legacy and current FFmpeg. */
export function helpSupportsFpsMode(help: string): boolean {
  return /(?:^|\r?\n)\s*-fps_mode(?:\s|:|\[)/.test(help);
}

function detectFpsMode(ffmpeg: string): Promise<boolean> {
  const cached = fpsModeSupport.get(ffmpeg);
  if (cached) return cached;
  const detected = execFileAsync(ffmpeg, ["-hide_banner", "-h", "full"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
    .then(({ stdout, stderr }) => helpSupportsFpsMode(`${stdout}\n${stderr}`))
    // FFmpeg 4.x lacks fps_mode but supports the equivalent legacy -vsync modes.
    // A genuinely missing executable still fails at the actual media operation.
    .catch(() => false);
  fpsModeSupport.set(ffmpeg, detected);
  return detected;
}

export async function ffmpegOutputTimingArgs(
  ffmpeg: string,
  mode: FfmpegOutputTimingMode,
): Promise<[string, FfmpegOutputTimingMode]> {
  return [(await detectFpsMode(ffmpeg)) ? "-fps_mode" : "-vsync", mode];
}
