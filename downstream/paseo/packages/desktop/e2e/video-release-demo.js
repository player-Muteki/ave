// Acceptance runs against an installed desktop app and the selected model endpoint.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocket } = require("ws");

const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const rationalIs = (value, n, d = 1) => BigInt(value.num) * BigInt(d) === BigInt(value.den) * BigInt(n);

async function until(read, check, name, timeout = 45000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (check(value)) return value;
    await delay(300);
  } while (Date.now() < end);
  throw Error("Timed out waiting for " + name);
}

async function runVideoReleaseDemo({ page, listen, source, evidence, media }) {
  const model = process.env.VIDEO_EDITOR_PLANNER_MODEL;
  assert.ok(model && !model.startsWith("fixture/") && !model.startsWith("probe/"), "Select the live acceptance model");
  assert.ok(evidence, "Set PASEO_DESKTOP_SMOKE_ARTIFACT_DIR to save the demo evidence");
  fs.mkdirSync(evidence, { recursive: true });
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const client = new DaemonClient({ url: `ws://${listen}/ws`, clientId: "ave-release-qa",
    webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) });
  const sourceHash = digest(source);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const executable = name => path.join(media, "bin", name + suffix);
  const probe = file => JSON.parse(execFileSync(executable("ffprobe"), ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", file]));
  const input = probe(source);
  assert.ok(Number(input.format.start_time) > 0);
  assert.ok(Math.abs(Number(input.format.duration) - Number(input.format.start_time) - 2.4) < 0.00001);
  const click = name => page.getByRole("button", { name, exact: true }).click();
  const screenshot = name => page.screenshot({ path: path.join(evidence, name + ".png") });
  const invoke = (name, input) => client.invokePluginRpc("video-editor", "video.v1." + name, input);
  try {
    await client.connect();
    const title = "AVE v0.1.0 demo " + Date.now();
    await page.getByRole("textbox", { name: "新项目名称" }).fill(title);
    await click("创建项目");
    const list = await until(() => invoke("list_projects", {}), r => r.projects.some(p => p.title === title), "created project");
    const { projectId } = list.projects.find(p => p.title === title);
    const snap = () => invoke("get_project", { projectId });
    const renderJobs = project => project.jobs.filter(j => j.kind !== "analysis");
    await page.locator('input[type="file"][aria-label="选择本机视频"]').setInputFiles(source);
    await click("导入所选视频");
    const imported = await until(snap, p => p.assets.length === 1, "imported source");
    assert.equal(imported.assets[0].original.sha256, sourceHash);
    const prompt = "保留最后一秒和原声";
    await page.getByRole("textbox", { name: "规划意图（自然语言）" }).fill(prompt);
    const proposals = [];
    for (const number of [1, 2]) {
      const before = await snap();
      await click("开始规划");
      const readProposal = async () => {
        const current = await snap();
        if (current.plans.length === number) return current;
        const batch = await invoke("get_events", { projectId, afterSeq: before.latestSeq });
        const ended = batch.events.find(e => ["run.failed", "run.interrupted", "run.settled"].includes(e.type));
        if (ended) {
          const latest = await snap();
          if (latest.plans.length === number) return latest;
          const trace = batch.events.map(({ seq, type, runId, payload }) => ({
            seq, type, runId, tool: type === "agent.tool_execution_start" ? payload?.tool : undefined,
          }));
          fs.writeFileSync(path.join(evidence, "unsubmitted-run.json"), JSON.stringify(trace, null, 2));
          throw Error("Planning run ended without a proposal: " + ended.type);
        }
        return current;
      };
      const project = await until(readProposal, p => p.plans.length === number, "model proposal " + number, 600000);
      const approval = project.approvals.find(a => a.purpose === "preview" && a.status === "pending");
      assert.ok(approval);
      const plan = project.plans.find(p => p.planId === approval.subjectId);
      assert.equal(plan.trimOperations.length, 1);
      const [op] = plan.trimOperations;
      assert.equal(op.source.assetContentHash, sourceHash);
      assert.ok(rationalIs(op.sourceRange.start, 7, 5) && rationalIs(op.sourceRange.duration, 1));
      assert.ok(rationalIs(op.recordRange.start, 0) && rationalIs(op.recordRange.duration, 1));
      assert.equal(renderJobs(project).length, 0);
      await until(() => invoke("get_planning_run", { projectId, runId: plan.runId }), r => r.state === "settled", "settled planner");
      await click("刷新事件");
      await page.getByText("预览审批", { exact: true }).waitFor();
      proposals.push({ runId: plan.runId, planId: plan.planId, planHash: plan.planHash, range: op.sourceRange });
      await screenshot("plan-" + number);
      if (number === 1) {
        await click("拒绝预览方案");
        const rejected = await until(snap, p => p.approvals.some(a => a.approvalId === approval.approvalId && a.status === "rejected"), "rejection");
        assert.equal(renderJobs(rejected).length, 0);
      }
    }
    const waitJob = async (kind, state) => {
      const project = await until(snap, p => p.jobs.some(j => j.kind === kind && [state, "failed"].includes(j.state)), kind);
      const job = project.jobs.find(j => j.kind === kind);
      assert.equal(job.state, state, JSON.stringify(job.error));
      await click("刷新项目");
      return job;
    };
    const play = async label => {
      await click(label);
      const player = page.locator('video[aria-label="' + label + '"]');
      await player.waitFor();
      await player.evaluate(async video => { video.muted = true; await video.play(); });
      await until(() => player.evaluate(v => v.ended), Boolean, "playback of " + label);
      await screenshot(label);
    };
    await click("批准并渲染预览");
    await waitJob("preview", "awaiting_review");
    await play("观看预览候选");
    await click("批准渲染成品候选");
    await waitJob("final", "awaiting_delivery_approval");
    await play("观看成品审片代理");
    await click("确认审片并批准导出");
    await waitJob("export", "completed");
    async function download(label, ext, target) {
      await click(label);
      const link = page.locator('a[download$="' + ext + '"]');
      const [file] = await Promise.all([page.waitForEvent("download"), link.click()]);
      await file.saveAs(target);
    }
    const output = path.join(evidence, "output.mp4");
    const manifestPath = path.join(evidence, "manifest.json");
    await download("准备下载成品视频", ".mp4", output);
    await download("准备下载导出清单", ".json", manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const outputHash = digest(output);
    assert.equal(manifest.output.sha256, outputHash);
    assert.equal(manifest.planHash, proposals[1].planHash);
    assert.equal(digest(source), sourceHash);
    const outputProbe = probe(output);
    const video = outputProbe.streams.find(s => s.codec_type === "video");
    const audio = outputProbe.streams.find(s => s.codec_type === "audio");
    assert.ok(video && audio);
    assert.equal(video.codec_name, "h264");
    assert.equal(audio.codec_name, "aac");
    assert.equal(video.nb_read_frames, "25");
    for (const stream of [video, audio]) {
      const [n, d] = stream.time_base.split("/").map(Number);
      assert.ok(Math.abs(Number(stream.start_pts) * n / d) <= n / d);
      assert.ok(Math.abs(Number(stream.duration_ts) * n / d - 1) <= n / d);
    }
    execFileSync(executable("ffmpeg"), ["-nostdin", "-v", "error", "-xerror", "-i", output, "-map", "0", "-f", "null", "-"]);
    const pcm = execFileSync(executable("ffmpeg"), ["-v", "error", "-i", output, "-map", "0:a:0", "-ar", "48000", "-ac", "1", "-f", "s16le", "pipe:1"]);
    let crossings = 0;
    for (let i = 4800; i < 28800; i++)
      if (pcm.readInt16LE(2*i) <= 0 && pcm.readInt16LE(2*i+2) > 0) crossings++;
    assert.ok(Math.abs(crossings - 440) <= 1, "Expected 880 Hz from the last second of the supplied fixture");
    const { approvals, jobs } = await snap();
    fs.writeFileSync(path.join(evidence, "demo.json"), JSON.stringify({
      platform: process.platform, arch: process.arch, model, projectId, prompt, proposals, approvals,
      jobs: jobs.map(({ jobId, kind, state }) => ({ jobId, kind, state })), sourceHash, outputHash,
      input, outputProbe, decoded: true, audioZeroCrossingsInHalfSecond: crossings,
    }, null, 2));
  } finally {
    await client.close();
  }
}
module.exports = { runVideoReleaseDemo };
