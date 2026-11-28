import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorError, editorFailure } from "@ave/contracts";

/**
 * Resolve the native Python media-worker directory (`services/media-worker`).
 */
export function resolveMediaWorkerDir(override?: string): string {
  const fromEnv = override ?? process.env.AVE_MEDIA_WORKER_DIR ?? process.env.VIDEO_EDITOR_WORKER_DIR;
  if (fromEnv && existsSync(path.join(fromEnv, "daemon_cli.py"))) {
    return fromEnv;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "../../media-worker");
  if (existsSync(path.join(candidate, "daemon_cli.py"))) {
    return candidate;
  }
  editorFailure("CAPABILITY_UNAVAILABLE", "Native AVE media-worker directory not found");
}

export interface WorkerSupport {
  python: string;
  numpy: boolean;
  scenedetect: boolean;
  cv2: boolean;
  hog: boolean;
}

export interface SamplingMapResult {
  presentation_index_sha256: string;
  source_clock: string;
  sample_rate: string;
  source_frames: Array<{ pts: string; duration: string }>;
  sample_to_source: number[];
  source_to_samples: number[][];
}

/**
 * Isolated runner for deterministic Python kernels (`python3 -I -B daemon_cli.py`, shell:false).
 */
export class AvePyWorker {
  private readonly dir: string;
  private readonly python: string;

  constructor(options: { workerDir?: string; python?: string } = {}) {
    this.dir = resolveMediaWorkerDir(options.workerDir);
    const mediaDir = process.env.AVE_MEDIA_DIR ?? process.env.VIDEO_EDITOR_MEDIA_DIR;
    this.python =
      options.python ??
      (mediaDir
        ? path.join(mediaDir, "python", process.platform === "win32" ? "python.exe" : "bin/python3")
        : "python3");
  }

  get workerDir(): string {
    return this.dir;
  }

  private run(
    args: string[],
    input: string,
    signal: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new EditorError("CANCELLED", "Analysis interrupted"));
        return;
      }
      let child;
      try {
        child = spawn(this.python, ["-I", "-B", path.join(this.dir, "daemon_cli.py"), ...args], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
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
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolve(stdout);
          return;
        }
        let detail = stderr.trim() || stdout.trim();
        try {
          const parsed = JSON.parse(stdout) as { error?: string; message?: string };
          if (parsed?.error) detail = `${parsed.error}: ${parsed.message}`;
        } catch {
          /* keep raw */
        }
        const error = new EditorError(
          code === 127 || /No module named|ModuleNotFoundError|CAPABILITY_UNAVAILABLE/.test(detail)
            ? "CAPABILITY_UNAVAILABLE"
            : "WORKER_FAILED",
          detail || `python worker exited ${code}`,
        );
        reject(error);
      });
      child.stdin.write(input);
      child.stdin.end();
    });
  }

  async support(signal: AbortSignal): Promise<WorkerSupport> {
    const stdout = await this.run(["support"], "", signal);
    return JSON.parse(stdout) as WorkerSupport;
  }

  async detectPeople(directory: string, signal: AbortSignal): Promise<unknown> {
    return JSON.parse(await this.run(["detect-people", "--directory", directory], "", signal));
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
        "--index",
        input.indexPath,
        "--index-sha256",
        input.indexSha256,
        "--source-sha256",
        input.sourceSha256,
        "--stream-uid",
        input.streamUid,
        "--first",
        String(input.first),
        "--stop",
        String(input.stop),
        "--rate",
        input.rate,
      ],
      "",
      signal,
    );
    return JSON.parse(stdout) as SamplingMapResult;
  }
}
