import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorError, editorFailure } from "./errors.js";

/**
 * Runner for the closed Python media kernels in plugins/video-editor/worker.
 * The kernels get only the CAS-owned presentation index bytes and JSON args;
 * they have no file, subprocess, model or network interface of their own.
 * A missing interpreter or dependency is a capability failure, never a
 * silent skip.
 */

export function resolveWorkerDir(here: string): string {
  const fromEnv = process.env.VIDEO_EDITOR_WORKER_DIR;
  if (fromEnv) return fromEnv;
  const candidates = [
    path.resolve(here, "../../../../../plugins/video-editor/worker"),
    path.resolve(here, "../../builtin-plugins/video-editor/worker"),
    path.resolve(here, "../../../../plugins/video-editor/worker"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "daemon_cli.py"))) return candidate;
  }
  editorFailure("CAPABILITY_UNAVAILABLE", "video worker directory not found");
  throw new Error("unreachable");
}

export interface WorkerSupport {
  python: string;
  numpy: boolean;
  scenedetect: boolean;
  cv2: boolean;
}

export interface SamplingMapResult {
  presentation_index_sha256: string;
  source_clock: string;
  sample_rate: string;
  source_frames: Array<{ pts: string; duration: string }>;
  sample_to_source: number[];
  source_to_samples: number[][];
}

export class PyWorker {
  private dir?: string;

  private workerDir(): string {
    if (!this.dir) this.dir = resolveWorkerDir(path.dirname(fileURLToPath(import.meta.url)));
    return this.dir;
  }

  private run(args: string[], input: string, signal: AbortSignal, timeoutMs = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) throw new EditorError("CANCELLED", "Analysis interrupted");
      let child;
      try {
        const mediaDir = process.env.VIDEO_EDITOR_MEDIA_DIR;
        const python = mediaDir
          ? path.join(mediaDir, "python", process.platform === "win32" ? "python.exe" : "bin/python3")
          : "python3";
        child = spawn(python, ["-I", "-B", path.join(this.workerDir(), "daemon_cli.py"), ...args], {
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("python worker timed out"));
      }, timeoutMs);
      const onAbort = () => {
        child.kill("SIGKILL");
        reject(new EditorError("CANCELLED", "Analysis interrupted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (code === 0) resolve(stdout);
        else {
          let detail = stderr.trim() || stdout.trim();
          try {
            const parsed = JSON.parse(stdout);
            if (parsed?.error) detail = `${parsed.error}: ${parsed.message}`;
          } catch { /* keep raw */ }
          const error = new Error(detail || `python worker exited ${code}`);
          (error as Error & { code?: string }).code =
            code === 127 || /No module named|ModuleNotFoundError/.test(detail)
              ? "CAPABILITY_UNAVAILABLE"
              : "WORKER_FAILED";
          reject(error);
        }
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  async support(signal: AbortSignal): Promise<WorkerSupport> {
    const stdout = await this.run(["support"], "", signal);
    return JSON.parse(stdout) as WorkerSupport;
  }

  async samplingMap(
    input: {
      indexPath: string;
      indexSha256: string;
      sourceSha256: string;
      streamUid: string;
      first: number;
      stop: number;
      rate: string;
    },
    signal: AbortSignal,
  ): Promise<SamplingMapResult> {
    const stdout = await this.run(
      [
        "sampling-map",
        "--index", input.indexPath,
        "--index-sha256", input.indexSha256,
        "--source-sha256", input.sourceSha256,
        "--stream-uid", input.streamUid,
        "--first", String(input.first),
        "--stop", String(input.stop),
        "--rate", input.rate,
      ],
      "",
      signal,
    );
    return JSON.parse(stdout) as SamplingMapResult;
  }
}
