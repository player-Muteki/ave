import { describe, expect, it } from "vitest";
import { VideoToolCallSchema, type EditPlanDraftV1, type EditorPrincipal } from "@ave/contracts";
import type { AveStore } from "@ave/sqlite";
import { AveToolBroker, type PlannerScope } from "../src/tool-broker.js";
import type { DaemonQueries } from "../src/store-queries.js";

const H = "a".repeat(64);

const principal: EditorPrincipal = { principalId: "op1", role: "operator", projectIds: null };
const scope: PlannerScope = { projectId: "p1", runId: "run-1", principal };

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

const draft: EditPlanDraftV1 = {
  schemaVersion: "video.edit-plan/v1",
  projectId: "p1",
  baseTimelineRevision: "1",
  baseAssetManifestHash: H,
  preferredDeterministicBackendId: "ffmpeg",
  intent: "Trim first second",
  trimOperations: [],
  transformOperations: [],
  audioOperations: [],
  transitionOperations: [],
  subtitleOperations: [],
  generationRequests: [],
  qaRequirements: [],
  externalDestinations: [],
  maxCostMicros: "0",
};

const planRow = {
  planId: "plan-1",
  planHash: "h".repeat(64),
  revision: "1",
  intent: "trim",
  trimOperations: [],
  transformOperations: [],
  audioOperations: [],
  transitionOperations: [],
  subtitleOperations: [],
};

/** Recording fake of the store + queries; every broker branch lands on one of these calls. */
function makeFakes(jobArtifacts: unknown[] = [{ kind: "qa", artifactId: "qa-1", revision: "0", blob: { sha256: H } }]) {
  const calls: string[] = [];
  const store = {
    projects: {
      getProjectSnapshot: () => {
        calls.push("projects.getProjectSnapshot");
        return {
          revision: "1",
          baseAssetManifestHash: H,
          assets: [
            {
              assetId: "a1",
              original: { sha256: H },
              presentationIndex: { sha256: H },
              streams: [],
            },
          ],
          plans: [planRow],
          approvals: [],
          jobs: [],
        };
      },
      plannerAssetMetadata: () => {
        calls.push("projects.plannerAssetMetadata");
        return { assetId: "a1", contentHash: H };
      },
    },
    jobs: {
      listArtifacts: () => {
        calls.push("jobs.listArtifacts");
        return [];
      },
      getJob: () => {
        calls.push("jobs.getJob");
        return {
          jobId: "j1",
          kind: "preview",
          state: "completed",
          revision: "0",
          planHash: "h".repeat(64),
          progress: "1",
          artifacts: jobArtifacts,
        };
      },
      analysisSummary: () => {
        calls.push("jobs.analysisSummary");
        return { assetId: "a1", state: "completed" };
      },
      runLifecycle: () => {
        calls.push("jobs.runLifecycle");
        return [{ runId: "run-1", state: "settled" }];
      },
      getEvents: () => {
        calls.push("jobs.getEvents");
        return { events: [] };
      },
    },
    plans: {
      getPlan: () => {
        calls.push("plans.getPlan");
        return { planId: "plan-1" };
      },
      validateProposal: () => {
        calls.push("plans.validateProposal");
      },
      estimateTimeline: () => {
        calls.push("plans.estimateTimeline");
        return { seconds: "2" };
      },
      createPlan: () => {
        calls.push("plans.createPlan");
        return { plan: { planId: "plan-9", planHash: "h".repeat(64), status: "proposed" } };
      },
    },
    objectEdits: {
      listObjectEdits: () => {
        calls.push("objectEdits.listObjectEdits");
        return [{ workflowId: "object-edit-1", assetId: "a1", state: "analyzing", candidates: [], decisions: [], workflowRevision: "0" }];
      },
    },
  } as unknown as AveStore;
  const queries = {
    sceneCuts: () => {
      calls.push("queries.sceneCuts");
      return { cuts: [] };
    },
    waveform: () => {
      calls.push("queries.waveform");
      return { buckets: [] };
    },
    qaSummary: () => {
      calls.push("queries.qaSummary");
      return { state: "completed" };
    },
  } as unknown as DaemonQueries;
  return { store, queries, calls };
}

function call(tool: string, args: unknown) {
  return { protocolVersion: "1", toolCallId: `call-${tool}`, tool, args };
}

const TOOL_ARGS: Record<string, unknown> = {
  get_project_snapshot: { projectId: "p1" },
  get_asset_metadata: { assetId: "a1", contentHash: H },
  get_job_status: { jobId: "j1" },
  list_artifacts: { jobId: "j1" },
  get_object_edits: { projectId: "p1" },
  validate_edit_plan: draft,
  estimate_timeline: { planId: "plan-1" },
  submit_edit_plan: draft,
  get_contact_sheet: { assetId: "a1", contentHash: H },
  get_qa_report: { jobId: "j1" },
  get_analysis: { assetId: "a1", contentHash: H },
  get_plan: { planId: "plan-1" },
  get_scene_cuts: { assetId: "a1", contentHash: H },
  get_waveform: { assetId: "a1", contentHash: H },
  get_planning_run: { projectId: "p1" },
  diff_plans: { planId: "plan-1", draft },
  get_qa_summary: { jobId: "j1" },
};

describe("AveToolBroker security boundary", () => {
  it("handles every tool in the contract union (no silent fallthrough)", async () => {
    const toolNames = VideoToolCallSchema.options.map((o) => o.shape.tool.value);
    expect(toolNames).toHaveLength(17);
    expect(Object.keys(TOOL_ARGS).sort()).toEqual([...toolNames].sort());
    for (const tool of toolNames) {
      const { store, queries, calls } = makeFakes();
      const broker = new AveToolBroker(store, queries, scope);
      const result = await broker.invoke(call(tool, TOOL_ARGS[tool]));
      expect(result, `tool ${tool} should produce a result`).not.toBeUndefined();
      expect(calls.length, `tool ${tool} should reach the store`).toBeGreaterThan(0);
    }
  });

  it("rejects malformed envelopes and unknown tools as INVALID_ARGUMENT", async () => {
    const { store, queries, calls } = makeFakes();
    const broker = new AveToolBroker(store, queries, scope);
    expect(await asyncCodeOf(() => broker.invoke({ protocolVersion: "1", tool: "get_project_snapshot", args: { projectId: "p1" } }))).toBe("INVALID_ARGUMENT");
    expect(await asyncCodeOf(() => broker.invoke(call("rogue_tool", {})))).toBe("INVALID_ARGUMENT");
    expect(await asyncCodeOf(() => broker.invoke(call("get_job_status", {})))).toBe("INVALID_ARGUMENT");
    expect(calls).toEqual([]);
  });

  it("is bound to its project: cross-project tool args are PERMISSION_DENIED", async () => {
    const { store, queries, calls } = makeFakes();
    const broker = new AveToolBroker(store, queries, scope);
    expect(
      await asyncCodeOf(() => broker.invoke(call("get_project_snapshot", { projectId: "other" }))),
    ).toBe("PERMISSION_DENIED");
    expect(
      await asyncCodeOf(() => broker.invoke(call("get_object_edits", { projectId: "other" }))),
    ).toBe("PERMISSION_DENIED");
    // diff_plans additionally checks the draft's own projectId
    expect(
      await asyncCodeOf(() => broker.invoke(call("diff_plans", { planId: "plan-1", draft: { ...draft, projectId: "other" } }))),
    ).toBe("PERMISSION_DENIED");
    expect(calls).toEqual([]);
  });

  it("scopes asset identity to the bound project (contact sheet hash mismatch)", async () => {
    const { store, queries } = makeFakes();
    const broker = new AveToolBroker(store, queries, scope);
    expect(
      await asyncCodeOf(() => broker.invoke(call("get_contact_sheet", { assetId: "a1", contentHash: "f".repeat(64) }))),
    ).toBe("ASSET_NOT_FOUND");
    expect(
      await asyncCodeOf(() => broker.invoke(call("get_contact_sheet", { assetId: "nope", contentHash: H }))),
    ).toBe("ASSET_NOT_FOUND");
  });

  it("reports missing QA artifact instead of guessing pass/fail", async () => {
    const { store, queries } = makeFakes([]);
    const broker = new AveToolBroker(store, queries, scope);
    expect(await asyncCodeOf(() => broker.invoke(call("get_qa_report", { jobId: "j1" })))).toBe("ASSET_NOT_FOUND");
  });
});
