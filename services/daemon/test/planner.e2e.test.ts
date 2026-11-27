import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  AveClient,
  SourceImport,
  createUploadChannels,
  sha256HexBrowserSafe,
} from "@ave/client-sdk";
import type {
  EditPlanDraftV1,
  JobSnapshot,
  PlanningRunStatus,
  SourceAsset,
} from "@ave/contracts";
import { AveDaemon } from "../src/index.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_SCRIPT = path.resolve(
  __dirname,
  "../../../conformance/r0-baseline/generate_golden_media.py",
);

const tempDirs: string[] = [];
const daemons: AveDaemon[] = [];
const httpServers: http.Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitForRunTerminal(
  client: AveClient,
  projectId: string,
  runId: string,
): Promise<PlanningRunStatus> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const status = await client.call<PlanningRunStatus>("video.v1.get_planning_run", {
      projectId,
      runId,
    });
    if (status.state === "settled" || status.state === "failed" || status.state === "interrupted") {
      return status;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for planning run ${runId}`);
}

async function waitForJobTerminal(
  client: AveClient,
  projectId: string,
  jobId: string,
  targets: string[],
): Promise<JobSnapshot> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await client.getJob(projectId, jobId);
    if (targets.includes(job.state)) return job;
    if (job.state === "failed" || job.state === "cancelled") {
      throw new Error(`Job ${jobId} failed: ${JSON.stringify(job.error)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function startMockProviderServer(
  handler: (body: { messages: Array<{ role: string; content?: string }> }) => Promise<unknown> | unknown,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages: Array<{ role: string; content?: string }>;
    };
    try {
      const reply = await handler(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  httpServers.push(server);
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/v1`;
}

afterEach(async () => {
  while (daemons.length) {
    await daemons.pop()!.stop().catch(() => {});
  }
  while (httpServers.length) {
    const s = httpServers.pop()!;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("@ave/daemon R3 Native Planner E2E", () => {
  it("runs NL -> native planner-worker -> EditPlan -> human approval -> real FFmpeg render and enforces closed tool boundaries", async () => {
    const mediaDir = await makeTempDir("ave-r3-media-");
    const aveHome = await makeTempDir("ave-r3-home-");

    await execFileAsync("python3", [GOLDEN_SCRIPT, "--out-dir", mediaDir]);
    const cfrPath = path.join(mediaDir, "cfr_25fps_av.mp4");
    const cfrBytes = await readFile(cfrPath);

    let mode: "happy" | "security" | "hang" = "happy";
    let step = 0;
    let projectRef: {
      projectId: string;
      revision: string;
      baseAssetManifestHash: string;
      assetId: string;
      assetSha256: string;
      streamUid: string;
    } = null as never;

    const baseUrl = await startMockProviderServer(async () => {
      if (mode === "hang") {
        await new Promise((r) => setTimeout(r, 15_000));
        return { choices: [{ message: { role: "assistant", content: "too late" } }] };
      }

      if (mode === "security") {
        step += 1;
        if (step === 1) {
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "bad-shell",
                      type: "function",
                      function: { name: "bash", arguments: JSON.stringify({ cmd: "id" }) },
                    },
                    {
                      id: "bad-approve",
                      type: "function",
                      function: {
                        name: "decide_approval",
                        arguments: JSON.stringify({ approvalId: "a1", decision: "approve" }),
                      },
                    },
                    {
                      id: "bad-cross-proj",
                      type: "function",
                      function: {
                        name: "get_project_snapshot",
                        arguments: JSON.stringify({ projectId: "other-project-999" }),
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Refused disallowed operations and closed safely.",
              },
            },
          ],
        };
      }

      step += 1;
      const draft: EditPlanDraftV1 = {
        schemaVersion: "video.edit-plan/v1",
        projectId: projectRef.projectId,
        baseTimelineRevision: projectRef.revision,
        baseAssetManifestHash: projectRef.baseAssetManifestHash,
        preferredDeterministicBackendId: "ffmpeg",
        intent: "Trim first 2 seconds via native planner",
        trimOperations: [
          {
            opId: "trim-1",
            order: "1",
            trackId: "v1",
            clipId: "clip-1",
            source: {
              assetId: projectRef.assetId,
              assetContentHash: projectRef.assetSha256,
              streamUid: projectRef.streamUid,
              probeRevision: "1",
            },
            sourceRange: { start: { num: "0", den: "1" }, duration: { num: "2", den: "1" } },
            recordRange: { start: { num: "0", den: "1" }, duration: { num: "2", den: "1" } },
          },
        ],
        transformOperations: [],
        audioOperations: [],
        transitionOperations: [],
        subtitleOperations: [],
        generationRequests: [],
        qaRequirements: [],
        externalDestinations: [],
        maxCostMicros: "0",
      };

      if (step === 1) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc-meta",
                    type: "function",
                    function: {
                      name: "get_asset_metadata",
                      arguments: JSON.stringify({
                        assetId: projectRef.assetId,
                        contentHash: projectRef.assetSha256,
                      }),
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      if (step === 2) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "tc-validate",
                    type: "function",
                    function: {
                      name: "validate_edit_plan",
                      arguments: JSON.stringify(draft),
                    },
                  },
                ],
              },
            },
          ],
        };
      }
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tc-submit",
                  type: "function",
                  function: {
                    name: "submit_edit_plan",
                    arguments: JSON.stringify(draft),
                  },
                },
              ],
            },
          },
        ],
      };
    });

    const daemon = await AveDaemon.create({
      aveHome,
      planner: { baseUrl, model: "scripted-mock-planner", maxTurns: 8 },
    });
    daemons.push(daemon);
    const addr = await daemon.start();

    const client = new AveClient({
      url: addr.wsUrl,
      auth: { kind: "localOwner", token: addr.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    await client.connect();

    const caps = await client.getCapabilities();
    expect(caps.features).toContain("native-planner");

    const project = await client.createProject({ requestId: "r3-p1", title: "R3 Native Planner" });
    const otherProj = await client.createProject({
      requestId: "r3-p2",
      title: "Other Isolated Project",
    });
    expect(otherProj.projectId).not.toBe(project.projectId);

    const importer = new SourceImport(
      project.projectId,
      {
        name: "cfr_25fps_av.mp4",
        size: cfrBytes.byteLength,
        type: "video/mp4",
        slice: (s = 0, e = cfrBytes.byteLength) => ({
          arrayBuffer: async () => cfrBytes.subarray(s, e).slice().buffer,
        }),
      },
      "r3-up-1",
    );
    const asset: SourceAsset = await importer.transfer(
      createUploadChannels(client),
      sha256HexBrowserSafe,
    );
    const refreshed = await client.getProject(project.projectId);
    const videoStream = asset.streams.find((s) => s.kind === "video")!;
    projectRef = {
      projectId: project.projectId,
      revision: refreshed.revision,
      baseAssetManifestHash: refreshed.baseAssetManifestHash,
      assetId: asset.assetId,
      assetSha256: asset.original.sha256,
      streamUid: videoStream.streamUid,
    };

    // 1. Happy path run
    const started = await client.call<PlanningRunStatus>("video.v1.start_planning_run", {
      requestId: "r3-run-1",
      projectId: project.projectId,
      prompt: "Trim the first 2 seconds cleanly",
    });
    expect(started.state).toBe("running");

    const settled = await waitForRunTerminal(client, project.projectId, started.runId);
    expect(settled.state).toBe("settled");

    // Verify agent_settled did NOT auto-approve or auto-create any render job
    const afterPlan = await client.getProject(project.projectId);
    expect(afterPlan.plans).toHaveLength(1);
    expect(afterPlan.approvals).toHaveLength(1);
    expect(afterPlan.approvals[0]!.status).toBe("pending");
    expect(afterPlan.jobs).toHaveLength(0);

    const runEvs = await client.call<{ events: Array<{ type: string }> }>(
      "video.v1.get_run_events",
      {
        requestId: "r3-rev-1",
        projectId: project.projectId,
        runId: started.runId,
      },
    );
    expect(runEvs.events.some((e) => e.type === "agent.plan_submitted")).toBe(true);

    // Human approves -> creates job -> real FFmpeg renders preview
    const approval = afterPlan.approvals[0]!;
    const approved = await client.decideApproval({
      requestId: "r3-dec-1",
      approvalId: approval.approvalId,
      expectedRevision: afterPlan.revision,
      decision: "approve",
    });
    const previewJob = await client.createJob({
      requestId: "r3-job-1",
      projectId: project.projectId,
      approvalId: approval.approvalId,
      grantId: approved.grant!.grantId,
      expectedRevision: afterPlan.revision,
    });
    const previewDone = await waitForJobTerminal(client, project.projectId, previewJob.job.jobId, [
      "awaiting_review",
    ]);
    expect(previewDone.artifacts.some((a) => a.kind === "qa")).toBe(true);

    // 2. Closed tool surface + cross-project isolation
    mode = "security";
    step = 0;
    const secStarted = await client.call<PlanningRunStatus>("video.v1.start_planning_run", {
      requestId: "r3-run-2",
      projectId: project.projectId,
      prompt: "Try disallowed tools",
    });
    const secSettled = await waitForRunTerminal(client, project.projectId, secStarted.runId);
    expect(secSettled.state).toBe("settled");
    const secEvents = await client.call<{ events: Array<{ type: string; payload: unknown }> }>(
      "video.v1.get_run_events",
      {
        requestId: "r3-rev-2",
        projectId: project.projectId,
        runId: secStarted.runId,
      },
    );
    expect(secEvents.events.filter((e) => e.type === "agent.tool_rejected").length).toBeGreaterThanOrEqual(2);
    const otherAfter = await client.getProject(otherProj.projectId);
    expect(otherAfter.plans).toHaveLength(0);

    // 3. Operator abort via stop_planning_run
    mode = "hang";
    const hangStarted = await client.call<PlanningRunStatus>("video.v1.start_planning_run", {
      requestId: "r3-run-3",
      projectId: project.projectId,
      prompt: "Hang and be aborted",
    });
    await new Promise((r) => setTimeout(r, 200));
    const stopped = await client.call<PlanningRunStatus>("video.v1.stop_planning_run", {
      projectId: project.projectId,
      runId: hangStarted.runId,
    });
    expect(stopped.state).toBe("interrupted");

    // 4. Restart reconciliation: reserve active run in store directly, restart daemon
    const reserved = daemon.store.jobs.reservePlanningRun(
      project.projectId,
      "r3-run-4",
      "Crash mid-run",
      daemon.ownerPrincipal(),
    );
    client.close();
    await daemon.stop();
    daemons.pop();

    const restarted = await AveDaemon.create({ aveHome });
    daemons.push(restarted);
    const restartedAddr = await restarted.start();
    const client2 = new AveClient({
      url: restartedAddr.wsUrl,
      auth: { kind: "localOwner", token: restartedAddr.ownerToken },
      WebSocketImpl: WebSocket as unknown as new (url: string) => never,
      reconnect: false,
    });
    await client2.connect();
    const reconciled = await client2.call<PlanningRunStatus>("video.v1.get_planning_run", {
      projectId: project.projectId,
      runId: reserved.receipt.runId,
    });
    expect(reconciled.state).toBe("interrupted");
    client2.close();
  });
});
