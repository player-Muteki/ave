import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = new URL(".", import.meta.url);
const pi = new URL("../../../references/pi-sdk-probe/", here);
const source = new URL("packages/coding-agent/src/core/", pi);
const expected = [
  "diff_plans",
  "estimate_timeline",
  "get_analysis",
  "get_asset_metadata",
  "get_contact_sheet",
  "get_job_status",
  "get_plan",
  "get_planning_run",
  "get_project_snapshot",
  "get_qa_report",
  "get_qa_summary",
  "get_scene_cuts",
  "get_waveform",
  "submit_edit_plan",
  "validate_edit_plan",
];

async function childProbe() {
  const [
    { createAgentSession },
    { SessionManager },
    { SettingsManager },
    { createExtensionRuntime },
    { createClosedVideoPlanner },
  ] = await Promise.all([
    import(new URL("sdk.ts", source)),
    import(new URL("session-manager.ts", source)),
    import(new URL("settings-manager.ts", source)),
    import(new URL("extensions/loader.ts", source)),
    import("../plugins/video-editor/worker/closed-session.mjs"),
  ]);
  const session = await createClosedVideoPlanner(
    { createAgentSession, SessionManager, SettingsManager, createExtensionRuntime },
    {
      cwd: process.cwd(),
      agentDir: process.env.PI_CODING_AGENT_DIR,
      invoke(request) {
        return new Promise((resolve, reject) => {
          process.once("message", (reply) => {
            if (reply.error) reject(new Error(reply.error));
            else resolve(reply.result);
          });
          process.send({ request });
        });
      },
    },
  );
  try {
    for (let pass = 0; pass < 2; pass++) {
      assert.deepEqual(session.getActiveToolNames().sort(), expected);
      assert.deepEqual(session.getCallableToolNames().sort(), expected);
      assert.deepEqual(
        session
          .getAllTools()
          .map((t) => t.name)
          .sort(),
        expected,
      );
      assert.deepEqual(session.resourceLoader.getExtensions().errors, []);
      assert.deepEqual(session.resourceLoader.getAgentsFiles().agentsFiles, []);
      assert.ok(!session.systemPrompt.includes("PROJECT_RESOURCE_CANARY"));
      if (pass === 0) await session.reload();
    }
    const tool = session.agent.state.tools.find((t) => t.name === "get_project_snapshot");
    const snapshot = await tool.execute("probe-call", { projectId: process.argv[3] });
    assert.equal(JSON.parse(snapshot.content[0].text).projectId, process.argv[3]);
    console.log(
      `Pi planner: ${expected.length} tools in all inventories before/after reload; project snapshot read via IPC`,
    );
  } finally {
    session.dispose();
    process.disconnect();
  }
}

async function parentProbe() {
  assert.equal(
    execFileSync("git", ["--no-lazy-fetch", "-C", fileURLToPath(pi), "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    "fcc33744b072b9bb5529fa4ff8b151f9fa578e14",
  );
  const { EditorService } = await import("../packages/server/dist/server/server/video/service.js");
  const { VideoToolBroker } =
    await import("../packages/server/dist/server/server/video/tool-broker.js");
  const root = await mkdtemp(path.join(tmpdir(), "video-planner-test-"));
  let service;
  try {
    const cwd = path.join(root, "work");
    const agentDir = path.join(root, "agent");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(agentDir);
    await writeFile(path.join(cwd, "AGENTS.md"), "PROJECT_RESOURCE_CANARY");
    await writeFile(
      path.join(cwd, ".pi", "extensions", "canary.ts"),
      "throw new Error('PROJECT_RESOURCE_CANARY');",
    );
    await writeFile(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    service = await EditorService.create({ paseoHome: path.join(root, "daemon") });
    await service.start();
    const principal = service.principalForOwner();
    const { projectId } = service.store.createProject({
      requestId: "create",
      title: "Pi conformance",
      principal,
    });
    const broker = new VideoToolBroker(service.store, {
      projectId,
      runId: "offline-probe",
      principal,
    });
    await new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(import.meta.url), ["--child", projectId], {
        cwd,
        execArgv: [
          "--experimental-transform-types",
          "--import",
          new URL("experimental/source-resolver.ts", new URL("../", source)).href,
        ],
        env: {
          HOME: root,
          PATH: path.dirname(process.execPath),
          PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
      child.on("message", (msg) => {
        try {
          child.send({ result: broker.invoke(msg.request) });
        } catch {
          child.send({ error: "Planner request rejected" });
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Planner probe exited ${code ?? signal}`));
      });
    });
  } finally {
    try {
      await service?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
if (process.argv[2] === "--child") await childProbe();
else await parentProbe();
