import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { VACE_MODEL } from "@ave/contracts";
import type { MediaWorkerTestAdapter } from "../src/index.js";

const execute = promisify(execFile);
export async function makePeopleClip(directory: string, offsetSeconds = 0): Promise<string> {
  const file = path.join(directory, "two-people.mp4");
  await execute("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i",
    "color=c=gray:s=160x128:r=25:d=1,drawbox=x=16:y=16:w=32:h=64:c=red:t=fill,drawbox=x=96:y=16:w=32:h=64:c=blue:t=fill",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-c:v", "libx264", "-threads:v", "1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-output_ts_offset", String(offsetSeconds), file]);
  return file;
}

export type WorkerMode = "normal" | "empty" | "unavailable" | "no-change" | "leak" | "timeout" | "missing-output";
export function recordedWorker(mode: () => WorkerMode = () => "normal"): MediaWorkerTestAdapter {
  return {
    async detectPeople(directory) {
      const { width, height, samples } = JSON.parse(await readFile(path.join(directory, "frames.json"), "utf8"));
      if (mode() === "unavailable") throw new Error("Recorded detector unavailable");
      const frames = samples.map((s: { ordinal: number }) => String(s.ordinal));
      return { backend: "recorded", frameWidth: width, frameHeight: height, frames: samples.length,
        tracks: mode() === "empty" ? [] : [16, 96].map(x => ({
          trackId: "track-" + x, firstFrame: frames[0], lastFrame: frames.at(-1), evidenceFrames: frames,
          box: { x: x / width, y: 16 / height, width: 32 / width, height: 64 / height },
          confidence: 0.95, areaRatio: 0.1, centrality: 0.7, visibility: 1, motion: 0, occlusion: 0,
        })) };
    },
    async inspectMask({ directory, width, height, points, saveLabel }) {
      const label = Buffer.alloc(width * height);
      const boxes = [16, 96].filter(x => points.some(p => p.foreground && p.x >= x && p.x < x + 32));
      for (const x of boxes) for (let y = 16; y < 80; y++) label.fill(255, y * width + x, y * width + x + 32);
      const overlay = boxes.map(x => "drawbox=x=" + x + ":y=16:w=32:h=64:c=green:t=3").join(",") || "null";
      await execute("ffmpeg", ["-v", "error", "-nostdin", "-i", "frame.png", "-vf", overlay, "-threads:v", "1", "overlay.png"], { cwd: directory });
      if (saveLabel) await writeFile(path.join(directory, "label.raw"), label);
      return { engine: "sam2.1-tiny", weightsSha256: "7".repeat(64),
        labelSha256: createHash("sha256").update(label).digest("hex"), foregroundPixels: label.filter(Boolean).length };
    },
    async trackMask({ directory, count, anchorRaw }) {
      for (let i = 0; i < count; i++) await writeFile(path.join(directory, "labels", String(i).padStart(5, "0") + ".raw"), anchorRaw);
      await execute("ffmpeg", ["-v", "error", "-nostdin", "-start_number", "0", "-i", "frames/%05d.jpg",
        "-vf", "drawbox=x=16:y=16:w=32:h=64:c=green:t=3", "-start_number", "0", "-threads:v", "1", "overlay/%05d.png"], { cwd: directory });
      return Array(count).fill(anchorRaw.filter(Boolean).length);
    },
    async generateShot(directory) {
      if (mode() === "missing-output") return;
      if (mode() === "timeout") throw new Error("Recorded timeout");
      const { width, height, seed } = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
      const composite = await readFile(path.join(directory, "source.rgb"));
      const changedPixels: number[] = [], protectedPixels: number[] = [];
      for (let i = 0; i < 9; i++) {
        const mask = await readFile(path.join(directory, i + ".raw"));
        let changed = 0;
        for (let p = 0; p < mask.length; p++) {
          const c = 3 * (i * mask.length + p);
          if (mode() !== "no-change" && mask[p] && (composite[c] !== 128 || composite[c+1] !== 128 || composite[c+2] !== 128)) {
            composite.fill(128, c, c + 3); changed++;
          }
        }
        if (mode() === "leak") composite[i * mask.length * 3] ^= 255;
        changedPixels.push(changed);
        protectedPixels.push(width * height - mask.filter(Boolean).length);
      }
      await writeFile(path.join(directory, "composite.rgb"), composite);
      await writeFile(path.join(directory, "report.json"), JSON.stringify({ modelRevision: VACE_MODEL, seed, steps: 20, changedPixels, protectedPixels }));
    },
  };
}
