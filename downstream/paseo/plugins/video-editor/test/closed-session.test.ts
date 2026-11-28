import { describe, expect, it } from "vitest";
import { createClosedVideoPlanner } from "../worker/closed-session.mjs";
import { proposeCut } from "../client/cut.js";
import type { ProjectSnapshot } from "../shared/contracts/v1.js";

// The closed planner factory is pure wiring around an injected Pi SDK. A mock
// SDK exercises its contract deterministically; the real-SDK integration is
// covered separately by scripts/check-video-planner.mjs (W2 probe).
const TOOL_NAMES = [
  "diff_plans",
  "estimate_timeline",
  "get_analysis",
  "get_asset_metadata",
  "get_contact_sheet",
  "get_job_status",
  "get_object_edits",
  "get_plan",
  "get_planning_run",
  "get_project_snapshot",
  "get_qa_report",
  "get_qa_summary",
  "get_scene_cuts",
  "get_waveform",
  "list_artifacts",
  "submit_edit_plan",
  "validate_edit_plan",
];

const project = {
  projectId: "p1",
  revision: "1",
  baseAssetManifestHash: "a".repeat(64),
  assets: [
    {
      assetId: "asset-1",
      displayName: "clip.mp4",
      original: { sha256: "b".repeat(64) },
      streams: [{ kind: "video", streamUid: "stream:0" }],
    },
  ],
} as unknown as ProjectSnapshot;

function makeSdk(options?: { inventoryMismatch?: boolean }) {
  const captured: { options?: any; settings?: any } = {};
  const disposed = { count: 0 };
  const activeNames = options?.inventoryMismatch ? [...TOOL_NAMES, "rogue_tool"] : TOOL_NAMES;
  const session = {
    getActiveToolNames: () => activeNames,
    getCallableToolNames: () => TOOL_NAMES,
    getAllTools: () => TOOL_NAMES.map((name) => ({ name })),
    dispose: () => {
      disposed.count += 1;
    },
  };
  const sdk = {
    createExtensionRuntime: () => ({ runtime: true }),
    SessionManager: { inMemory: (cwd: string) => ({ cwd }) },
    SettingsManager: {
      inMemory: (settings: any) => {
        captured.settings = settings;
        return { settings };
      },
    },
    createAgentSession: async (opts: any) => {
      captured.options = opts;
      return { session };
    },
  };
  return { sdk, captured, disposed, session };
}

function toolByName(captured: { options?: any }, name: string) {
  const tool = captured.options.customTools.find((t: any) => t.name === name);
  expect(tool).toBeDefined();
  return tool;
}

describe("createClosedVideoPlanner", () => {
  it("exposes exactly the allowed video tools with JSON-schema parameters", async () => {
    const { sdk, captured } = makeSdk();
    await createClosedVideoPlanner(sdk, { cwd: "/w", agentDir: "/a", invoke: async () => ({}) });
    const tools = captured.options.customTools;
    expect(tools.map((t: any) => t.name).sort()).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.label).toBe(tool.name);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.executionMode).toBe("sequential");
      // parameters is a JSON schema derived from the tool args, with $schema stripped.
      expect(tool.parameters.$schema).toBeUndefined();
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.properties).toBeTypeOf("object");
    }
  });

  it("constrains sampling only for submit_edit_plan", async () => {
    const { sdk, captured } = makeSdk();
    await createClosedVideoPlanner(sdk, { cwd: "/w", agentDir: "/a", invoke: async () => ({}) });
    expect(toolByName(captured, "submit_edit_plan").constrainedSampling).toEqual({
      type: "json_schema",
      strict: "require",
    });
    for (const name of TOOL_NAMES.filter((n) => n !== "submit_edit_plan")) {
      expect(toolByName(captured, name).constrainedSampling).toBe(false);
    }
  });

  it("seals planner resources and exposes the fixed system prompt", async () => {
    const { sdk, captured } = makeSdk();
    await createClosedVideoPlanner(sdk, { cwd: "/w", agentDir: "/a", invoke: async () => ({}) });
    const resources = captured.options.resourceLoader;
    expect(resources.getSystemPrompt()).toContain("video edit planner");
    expect(resources.getSystemPrompt()).toContain("Only the human can approve");
    expect(() => resources.extendResources()).toThrow("Planner resources are sealed");
    expect(resources.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(resources.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(resources.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(resources.getExtensions().extensions).toEqual([]);
  });

  it("disables builtin tools and warming/retry/compaction", async () => {
    const { sdk, captured } = makeSdk();
    await createClosedVideoPlanner(sdk, { cwd: "/w", agentDir: "/a", invoke: async () => ({}) });
    expect(captured.options.noTools).toBe("all");
    expect([...captured.options.tools].sort()).toEqual(TOOL_NAMES);
    expect(captured.settings).toEqual({
      cacheWarming: "off",
      retry: { enabled: false },
      compaction: { enabled: false },
    });
  });

  it("execute parses the envelope, invokes the daemon and projects the output", async () => {
    const { sdk, captured } = makeSdk();
    const seen: any[] = [];
    const output = { revision: "3", assetCount: 1 };
    await createClosedVideoPlanner(sdk, {
      cwd: "/w",
      agentDir: "/a",
      invoke: async (request: any) => {
        seen.push(request);
        return output;
      },
    });
    const tool = toolByName(captured, "get_project_snapshot");
    const result = await tool.execute("call-1", { projectId: "p1" });
    expect(seen).toEqual([
      { protocolVersion: "1", toolCallId: "call-1", tool: "get_project_snapshot", args: { projectId: "p1" } },
    ]);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(output) }]);
    expect(result.details).toBe(output);
    expect(result.terminate).toBeUndefined();
  });

  it("submit_edit_plan terminates the planner session after a valid submission", async () => {
    const { sdk, captured } = makeSdk();
    const draft = proposeCut(project, "asset-1", "1.5", "4.05");
    const seen: any[] = [];
    await createClosedVideoPlanner(sdk, {
      cwd: "/w",
      agentDir: "/a",
      invoke: async (request: any) => {
        seen.push(request);
        return { planId: "plan-1", status: "proposed" };
      },
    });
    const tool = toolByName(captured, "submit_edit_plan");
    const result = await tool.execute("call-2", draft);
    expect(seen[0]).toMatchObject({ protocolVersion: "1", toolCallId: "call-2", tool: "submit_edit_plan" });
    expect(seen[0].args).toEqual(draft);
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ planId: "plan-1", status: "proposed" });
  });

  it("execute rejects model-supplied args that violate the tool schema before invoking", async () => {
    const { sdk, captured } = makeSdk();
    let invoked = 0;
    await createClosedVideoPlanner(sdk, {
      cwd: "/w",
      agentDir: "/a",
      invoke: async () => {
        invoked += 1;
        return {};
      },
    });
    const tool = toolByName(captured, "get_project_snapshot");
    // Invalid id (space) and a stray extra key both fail the strict args schema.
    await expect(tool.execute("call-3", { projectId: "bad id" })).rejects.toThrow();
    await expect(tool.execute("call-4", { projectId: "p1", extra: true })).rejects.toThrow();
    expect(invoked).toBe(0);
  });

  it("disposes the session and throws when the live tool inventory drifts", async () => {
    const { sdk, disposed } = makeSdk({ inventoryMismatch: true });
    await expect(
      createClosedVideoPlanner(sdk, { cwd: "/w", agentDir: "/a", invoke: async () => ({}) }),
    ).rejects.toThrow("Pi planner tool inventory mismatch");
    expect(disposed.count).toBe(1);
  });

  it("returns the live session when all three inventories match", async () => {
    const { sdk, session, disposed } = makeSdk();
    const returned = await createClosedVideoPlanner(sdk, {
      cwd: "/w",
      agentDir: "/a",
      invoke: async () => ({}),
    });
    expect(returned).toBe(session);
    expect(disposed.count).toBe(0);
  });
});