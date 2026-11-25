import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AgentRunController } from "./controller.js";
import { videoPlannerPromptSignature } from "./prompt.js";
import { EditorStore } from "../store.js";

const owner = { principalId: "owner", role: "owner" as const, projectIds: null };

it.each(["dispose", "EOF", "SIGTERM"] as const)("reaps a real initialized Pi worker on %s", async (how) => {
  const home = await mkdtemp(path.join(tmpdir(), "planner-test-"));
  const worker = fileURLToPath(new URL("./worker-main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), worker], {
    env: { HOME: home, TMPDIR: home, PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  try {
    const first = once(lines, "line");
    child.stdin.write(JSON.stringify({ kind: "init", protocolVersion: "1", projectId: "p", runId: "r", sessionId: "s", promptSignature: videoPlannerPromptSignature() }) + "\n");
    const [line] = await Promise.race([first, closed.then(() => { throw new Error("Worker exited before hello"); })]);
    expect(JSON.parse(line)).toMatchObject({kind: "hello", runId: "r", sessionId: "s", workerPid: child.pid});
    expect((await readdir(home)).filter(f => f.startsWith("ave-planner-r-"))).toHaveLength(1);
    if (how === "dispose") child.stdin.write('{"kind":"dispose"}\n');
    else if (how === "EOF") child.stdin.end();
    else child.kill("SIGTERM");
    expect(await closed).toEqual([0, null]);
    expect((await readdir(home)).filter(f => f.startsWith("ave-planner-r-"))).toEqual([]);
  } finally {
    lines.close();
    child.kill("SIGKILL");
    await closed;
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

it("replays one start receipt, stops before first prompt, and reconciles an abandoned receipt after reopen", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "planner-store-"));
  let store = await EditorStore.create(root);
  let controller = new AgentRunController(store);
  try {
    const { projectId } = store.createProject({ requestId: "project", title: "Supervision", principal: owner });
    const input = { projectId, requestId: "start", prompt: "Do not send: stopped before worker initialization" };
    const run = await controller.startRun(input, owner);
    expect(await controller.startRun(input, owner)).toEqual(run);
    const stop = controller.stopRun(projectId, run.runId, owner);
    await expect(stop).resolves.toMatchObject({ state: "interrupted" });
    expect(store.runLifecycle(projectId, owner)).toEqual([{ runId: run.runId, state: "interrupted" }]);
    expect(controller.status(projectId, run.runId, owner)).toEqual({ ...run, state: "interrupted" });
    const abandoned = store.reservePlanningRun(projectId, "other", "Unstarted", owner).receipt;
    const completed = (["settled", "failed"] as const).map(state => {
      const receipt = store.reservePlanningRun(projectId, state, "Recorded run", owner).receipt;
      store.recordExternalEvent(projectId, `run.${state}`, { runId: receipt.runId }, owner);
      store.recordExternalEvent(projectId, "run.progress", { runId: receipt.runId }, owner);
      return { ...receipt, state };
    });
    store.close();
    store = await EditorStore.create(root);
    controller = new AgentRunController(store);
    controller.reconcile(store.projectsWithPlanningEvents(), owner);
    expect(store.runLifecycle(projectId, owner)).toContainEqual({ runId: abandoned.runId, state: "interrupted" });
    expect(controller.status(projectId, abandoned.runId, owner)).toEqual({ ...abandoned, state: "interrupted" });
    for (const result of completed) expect(controller.status(projectId, result.runId, owner)).toEqual(result);
    expect(controller.status(projectId, run.runId, owner)).toEqual({ ...run, state: "interrupted" });
    const other = store.createProject({ requestId: "second", title: "Other", principal: owner });
    expect(() => controller.status(other.projectId, run.runId, owner)).toThrow("No such planning run");
    expect(() => controller.status(projectId, run.runId, { principalId: "outsider", role: "viewer", projectIds: [] })).toThrow();
    expect(store.project(projectId, owner).jobs).toEqual([]);
  } finally {
    await controller.disposeAll();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
