import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

export interface LaunchedDaemon {
  aveHome: string;
  wsUrl: string;
  healthUrl: string;
  port: number;
  ownerToken: string;
  pid: number;
  stop(): Promise<void>;
}

export interface DaemonLaunchOptions {
  aveHome?: string;
  host?: string;
  port?: number;
  ownerToken?: string;
  daemonCliPath?: string;
  startupTimeoutMs?: number;
}

export async function launchDesktopDaemon(
  options: DaemonLaunchOptions = {},
): Promise<LaunchedDaemon> {
  const ownerToken = options.ownerToken ?? randomBytes(24).toString("base64url");
  const distCli = path.join(REPO_ROOT, "services/daemon/dist/cli.js");
  const srcCli = path.join(REPO_ROOT, "services/daemon/src/cli.ts");
  const cliPath = options.daemonCliPath ?? (existsSync(distCli) ? distCli : srcCli);
  const useTsx = cliPath.endsWith(".ts");

  const args = useTsx ? ["--import", "tsx", cliPath] : [cliPath];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(options.aveHome ? { AVE_HOME: options.aveHome } : {}),
      AVE_HOST: options.host ?? "127.0.0.1",
      AVE_PORT: String(options.port ?? 0),
      AVE_OWNER_TOKEN: ownerToken,
    },
  });

  const stderrLines: string[] = [];
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderrLines.push(chunk));
  }

  const ready = await new Promise<{
    aveHome: string;
    wsUrl: string;
    healthUrl: string;
    port: number;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`AVE daemon startup timed out: ${stderrLines.join("")}`));
    }, options.startupTimeoutMs ?? 15_000);

    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`AVE daemon exited early (${code}): ${stderrLines.join("")}`));
    });

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as {
          ready?: boolean;
          aveHome?: string;
          wsUrl?: string;
          healthUrl?: string;
          port?: number;
        };
        if (parsed.ready && parsed.wsUrl && parsed.healthUrl && parsed.aveHome && parsed.port) {
          clearTimeout(timer);
          rl.close();
          resolve({
            aveHome: parsed.aveHome,
            wsUrl: parsed.wsUrl,
            healthUrl: parsed.healthUrl,
            port: parsed.port,
          });
        }
      } catch {
        // Ignore non-JSON startup output
      }
    });
  });

  return {
    ...ready,
    ownerToken,
    pid: child.pid ?? 0,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.killed) return resolve();
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 4000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
