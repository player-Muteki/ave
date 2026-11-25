import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { EditorService } from "./service.js";

it("keeps fractionally timed analysis jobs, Python samples and scene PTS aligned", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ave-fractional-analysis-"));
  const editor = await EditorService.create({ paseoHome: home });
  try {
    await editor.start();
    const principal = editor.principalForOwner();
    const { projectId } = editor.store.createProject({ title: "Fractional rate", requestId: "create", principal });
    const source = path.join(home, "fractional.mp4");
    await promisify(execFile)("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:size=32x32:rate=24000/1001",
      "-vf", "negate=enable='between(n,601,1201)+gte(n,1803)'", "-frames:v", "2400", "-c:v", "libx264",
      "-video_track_timescale", "24000", source]);
    const bytes = await readFile(source);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const { uploadId } = editor.store.createUpload({ projectId, principal, requestId: "u", expectedSize: String(bytes.length),
      displayName: "fractional.mp4", mediaType: "video/mp4", expectedSha256: sha });
    await editor.media.writeUploadChunk(uploadId, "0", bytes, principal);
    const asset = await editor.media.commitUpload(uploadId, "commit", sha, principal);
    const analysis = (requestId: string, rate?: string) => editor.store.createAnalysisJob({
      projectId, assetId: asset.assetId, principal, requestId, rate,
    });
    for (const rate of ["1/0", "0/2", "-1/1", "1.25", ""]) {
      expect(() => analysis("bad", rate)).toThrow("positive rational");
    }
    expect(analysis("default").job.analysisRate).toBe("25/1");
    expect(analysis("integer", "25/1").deduplicated).toBe(true);
    expect(analysis("low", "1/2").job.analysisRate).toBe("1/1");
    expect(analysis("high", "1001/1").job.analysisRate).toBe("1000/1");
    expect(analysis("exact-low", "1/1").deduplicated).toBe(true);
    expect(analysis("exact-high", "1000/1").deduplicated).toBe(true);
    for (const [rate, samples] of [["24000/1001", 2400], ["30000/1001", 3000]] as const) {
      const { job } = analysis("fraction-" + samples, rate);
      expect(job.analysisRate).toBe(rate);
      if (samples === 2400) expect(analysis("equivalent", "48000/2002").job.jobId).toBe(job.jobId);
      const result = await editor.media.executeAnalysisJob(projectId, job.jobId, new AbortController().signal);
      const readArtifact = async (kind: string) =>
        JSON.parse((await editor.cas.readBytes(result.artifacts.find(a => a.kind === kind)!.blob)).toString("utf8"));
      const report = await readArtifact("qa");
      expect(report.samplingError).toBeUndefined();
      expect(report.rate).toBe(rate);
      const map = report.streams[0].map;
      expect(map.sample_rate).toBe(rate);
      expect(map.sample_to_source).toHaveLength(samples);
      expect(map.sample_to_source.at(-1)).toBe(2399);
      const scenes = await readArtifact("scenecuts");
      expect(scenes.cuts.map((c: { frameIndex: number }) => c.frameIndex)).toEqual([601, 1202, 1803]);
      for (const cut of scenes.cuts) {
        const pts = BigInt(map.source_frames[cut.frameIndex].pts);
        expect(pts).toBe(BigInt(cut.frameIndex) * 1001n);
        expect(BigInt(cut.aligned.num) * 24000n).toBe(pts * 1000n * BigInt(cut.aligned.den));
      }
    }
    expect(createHash("sha256").update(await readFile(source)).digest("hex")).toBe(sha);
  } finally {
    await editor.stop();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
