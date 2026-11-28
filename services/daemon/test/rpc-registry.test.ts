import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as contracts from "@ave/contracts";
import type { AveCaller } from "@ave/domain";
import { AveRpcRegistry, type AveRpcDependencies } from "../src/rpc-registry.js";

const R0_SPEC = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../conformance/r0-baseline/baseline-spec.json"), "utf8"),
) as { rpcSurface: { mainSwitchMethods: string[] } };

const contractRpcNames = Object.entries(contracts)
  .filter(([, value]) => typeof (value as { name?: unknown }).name === "string")
  .map(([, value]) => (value as { name: string }).name)
  .filter((name) => name.startsWith("video.v1."))
  .sort();

const viewer: AveCaller = {
  principalId: "v1",
  editorPrincipal: { principalId: "v1", role: "viewer", projectIds: null },
};
const operator: AveCaller = {
  principalId: "op1",
  editorPrincipal: { principalId: "op1", role: "operator", projectIds: null },
};
const owner: AveCaller = { principalId: "owner", isLocalOwner: true };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

/** Minimal recording fake of the daemon dependencies; only the methods the tests invoke exist. */
function makeDeps() {
  const calls: string[] = [];
  const deps = {
    store: {
      projects: {
        listProjects: (principal: unknown) => {
          calls.push("projects.listProjects");
          return [{ projectId: "p1", title: "t", revision: "0", principal: principal as never }];
        },
        createProject: () => {
          calls.push("projects.createProject");
          return { projectId: "p-new" };
        },
      },
      objectEdits: {
        recordObjectQa: () => {
          calls.push("objectEdits.recordObjectQa");
          return { workflowId: "object-edit-x", state: "completed" };
        },
      },
    },
    cas: {},
    backends: {},
    jobs: {},
    uploads: {},
    queries: {},
    onProjectEvent: () => {
      calls.push("onProjectEvent");
    },
  } as unknown as AveRpcDependencies;
  return { deps, calls };
}

describe("AveRpcRegistry security boundary", () => {
  it("registers exactly the R0 main-switch methods and every contract RPC is handled", () => {
    const { deps } = makeDeps();
    const registry = new AveRpcRegistry(deps);
    expect(registry.listRegisteredMethods()).toEqual([...R0_SPEC.rpcSurface.mainSwitchMethods].sort());
    const registered = new Set(registry.listRegisteredMethods());
    expect(contractRpcNames.length).toBeGreaterThan(50);
    for (const name of contractRpcNames) {
      expect(registered.has(name)).toBe(true);
    }
  });

  it("rejects unknown and non-video methods before any handler runs", async () => {
    const { deps, calls } = makeDeps();
    const registry = new AveRpcRegistry(deps);
    expect(await asyncCodeOf(() => registry.invoke("video.v1.nope", {}, owner))).toBe("CAPABILITY_UNAVAILABLE");
    expect(await asyncCodeOf(() => registry.invoke("fs.readFile", {}, owner))).toBe("PERMISSION_DENIED");
    expect(calls).toEqual([]);
  });

  it("denies a viewer write before the handler touches the store", async () => {
    const { deps, calls } = makeDeps();
    const registry = new AveRpcRegistry(deps);
    const code = await asyncCodeOf(() =>
      registry.invoke("video.v1.create_project", { requestId: "r1", title: "t" }, viewer),
    );
    expect(code).toBe("PERMISSION_DENIED");
    expect(calls).toEqual([]);
  });

  it("allows a viewer read and reaches the store", async () => {
    const { deps, calls } = makeDeps();
    const registry = new AveRpcRegistry(deps);
    const result = (await registry.invoke("video.v1.list_projects", {}, viewer)) as {
      projects: unknown[];
    };
    expect(result.projects).toHaveLength(1);
    expect(calls).toEqual(["projects.listProjects"]);
  });

  it("gates owner-only manage methods: operator denied, owner reaches the store", async () => {
    const { deps, calls } = makeDeps();
    const registry = new AveRpcRegistry(deps);
    const qaInput = {
      requestId: "qa-1",
      projectId: "p1",
      workflowId: "object-edit-x",
      expectedWorkflowRevision: "3",
      qa: { frames: "9", residualRatio: 0.01, completeRatio: 0.99, flickerRatio: 0.01 },
    };
    expect(await asyncCodeOf(() => registry.invoke("video.v1.record_object_qa", qaInput, operator))).toBe(
      "PERMISSION_DENIED",
    );
    expect(calls).toEqual([]);
    const result = (await registry.invoke("video.v1.record_object_qa", qaInput, owner)) as {
      workflow: { state: string };
    };
    expect(result.workflow.state).toBe("completed");
    expect(calls).toEqual(["objectEdits.recordObjectQa"]);
  });

  it("validates the input shape against the contract schema before the store runs", async () => {
    const { deps, calls } = makeDeps();
    const registry = new AveRpcRegistry(deps);
    // missing requestId/title
    expect(await asyncCodeOf(() => registry.invoke("video.v1.create_project", {}, owner))).toBe(
      "INVALID_ARGUMENT",
    );
    // wrong type for a field
    expect(
      await asyncCodeOf(() =>
        registry.invoke("video.v1.create_project", { requestId: "r", title: 42 }, owner),
      ),
    ).toBe("INVALID_ARGUMENT");
    expect(calls).toEqual([]);
    // well-formed input passes schema and reaches the store
    const result = (await registry.invoke(
      "video.v1.create_project",
      { requestId: "r1", title: "hello" },
      owner,
    )) as { projectId: string };
    expect(result.projectId).toBe("p-new");
    expect(calls).toEqual(["projects.createProject", "onProjectEvent"]);
  });
});
