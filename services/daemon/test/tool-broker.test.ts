import { describe, expect, it, vi } from "vitest";
import { VideoToolCallSchema, EditorError, type EditPlanDraftV1 } from "@ave/contracts";
import { AveToolBroker } from "../src/tool-broker.js";

const HASH = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PROJECT = "p1";
const RUN = "run-1";
const principal = { principalId: "owner", role: "owner" as const, projectIds: null };

function draft(projectId: string, overrides: Partial<EditPlanDraftV1> = {}): EditPlanDraftV1 {
  return {
    schemaVersion: "video.edit-plan/v1",
    projectId,
    baseTimelineRevision: "0",
    baseAssetManifestHash: HASH,
    intent: "trim the tail",
    trimOperations: [],
    transformOperations: [],
    audioOperations: [],
    transitionOperations: [],
    subtitleOperations: [],
    generationRequests: [],
    qaRequirements: [],
    externalDestinations: [],
    maxCostMicros: "0",
    ...overrides,
  };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(EditorError);
  await promise.catch((error: EditorError) => expect(error.code).toBe(code));
}

function build(options: { assetCount?: number; planCount?: number; plans?: unknown[] } = {}) {
  const assetCount = options.assetCount ?? 1;
  const assets = Array.from({ length: assetCount }, (_, i) => ({
    assetId: `asset-${i}`,
    original: { sha256: HASH },
    presentationIndex: { sha256: HASH_B },
    streams: [{ streamUid: "s0", kind: "video", codec: "h264", width: 1280, height: 720, averageRate: "30/1" }],
  }));
  const planRecords = options.plans ?? Array.from({ length: options.planCount ?? 1 }, (_, i) => ({
    planId: `plan-${i}`,
    revision: "1",
    planHash: HASH,
    intent: "trim the tail",
    trimOperations: [{ opId: "op-1", startUs: "0", endUs: "1000" }],
    transformOperations: [],
    audioOperations: [],
    transitionOperations: [],
    subtitleOperations: [],
  }));
  const snapshot = {
    projectId: PROJECT,
    revision: "3",
    baseAssetManifestHash: HASH,
    assets,
    plans: planRecords,
    approvals: [{ status: "pending" }, { status: "approved" }],
    jobs: [
      { jobId: "job-1", kind: "analysis", state: "succeeded", revision: "2", analysisAssetId: "asset-0" },
      { jobId: "job-0", kind: "export", state: "running", revision: "1" },
    ],
  };

  const getProjectSnapshot = vi.fn(() => snapshot);
  const listObjectEdits = vi.fn(() => [
    {
      workflowId: "wf-1",
      assetId: "asset-0",
      state: "decided",
      candidates: [],
      decisions: [{ decision: "remove" }],
      workflowRevision: "2",
    },
  ]);
  const getJob = vi.fn((_projectId: string, jobId: string) => ({
    jobId,
    kind: "export",
    state: "succeeded",
    revision: "2",
    progress: "1",
    artifacts: jobId === "job-qa" ? [{ kind: "qa", artifactId: "art-qa", revision: "1", blob: { sha256: HASH } }] : [],
  }));
  const validateProposal = vi.fn();
  const createPlan = vi.fn((input: { requestId: string; toolCallId: string; runId: string }) => ({
    plan: { planId: "plan-new", planHash: HASH, status: "proposed", requestId: input.requestId },
  }));
  const estimateTimeline = vi.fn((input: { requestId: string }) => ({ requestId: input.requestId, durationUs: "1000" }));
  const getPlan = vi.fn(() => planRecords[0]);
  const plannerAssetMetadata = vi.fn(() => ({ assetId: "asset-0" }));

  const deps = {
    store: {
      projects: { getProjectSnapshot, plannerAssetMetadata },
      objectEdits: { listObjectEdits },
      jobs: {
        getJob,
        listArtifacts: vi.fn(() => ({ artifacts: [] })),
        analysisSummary: vi.fn(() => ({})),
        runLifecycle: vi.fn(() => [{ runId: RUN, state: "running" }]),
        getEvents: vi.fn(() => ({ events: [{ seq: "1", type: "run.started", runId: RUN, payload: { a: 1 } }] })),
      },
      plans: { getPlan, validateProposal, createPlan, estimateTimeline },
    },
    queries: {
      sceneCuts: vi.fn(async () => ({ cuts: [] })),
      waveform: vi.fn(async () => ({ peaks: [] })),
      qaSummary: vi.fn(async () => ({})),
    },
    scope: { projectId: PROJECT, runId: RUN, principal },
  };

  const broker = new AveToolBroker(
    deps.store as unknown as ConstructorParameters<typeof AveToolBroker>[0],
    deps.queries as unknown as ConstructorParameters<typeof AveToolBroker>[1],
    deps.scope,
  );

  return { broker, spies: { ...deps.store, ...deps.queries, getProjectSnapshot, listObjectEdits, getJob, getPlan } };
}

function call(tool: string, args: Record<string, unknown>, toolCallId = "call-1") {
  return { protocolVersion: "1", toolCallId, tool, args };
}

describe("AveToolBroker project binding", () => {
  it("rejects a malformed envelope without reaching the store", async () => {
    const { broker, spies } = build();
    await expectFailure(broker.invoke({ tool: "get_project_snapshot", args: { projectId: PROJECT } }), "INVALID_ARGUMENT");
    await expectFailure(broker.invoke(call("no_such_tool", {})), "INVALID_ARGUMENT");
    expect(spies.getProjectSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a tool call naming a different project", async () => {
    const { broker, spies } = build();
    await expectFailure(broker.invoke(call("get_project_snapshot", { projectId: "p2" })), "PERMISSION_DENIED");
    expect(spies.getProjectSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a plan draft that belongs to another project", async () => {
    const { broker, spies } = build();
    await expectFailure(
      broker.invoke(call("diff_plans", { planId: "plan-0", draft: draft("p2") })),
      "PERMISSION_DENIED",
    );
    expect(spies.getProjectSnapshot).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown plan id", async () => {
    const { broker } = build({ plans: [] });
    await expectFailure(
      broker.invoke(call("diff_plans", { planId: "plan-404", draft: draft(PROJECT) })),
      "ASSET_NOT_FOUND",
    );
  });

  it("returns a bounded snapshot with truncation flags", async () => {
    const { broker } = build({ assetCount: 70, planCount: 40 });
    const result = (await broker.invoke(call("get_project_snapshot", { projectId: PROJECT }))) as {
      assets: unknown[];
      hasMoreAssets: boolean;
      plans: unknown[];
      hasMorePlans: boolean;
      pendingApprovalCount: number;
      objectEditCount: number;
    };
    expect(result.assets).toHaveLength(64);
    expect(result.hasMoreAssets).toBe(true);
    expect(result.plans).toHaveLength(32);
    expect(result.hasMorePlans).toBe(true);
    expect(result.pendingApprovalCount).toBe(1);
    expect(result.objectEditCount).toBe(1);
  });

  it("passes the optional asset filter through to object edits", async () => {
    const { broker, spies } = build();
    await broker.invoke(call("get_object_edits", { projectId: PROJECT, assetId: "asset-0" }));
    expect(spies.listObjectEdits).toHaveBeenCalledWith(PROJECT, "asset-0", principal);
  });

  it("fails closed when a job has no QA artifact", async () => {
    const { broker } = build();
    await expectFailure(broker.invoke(call("get_qa_report", { jobId: "job-1" })), "ASSET_NOT_FOUND");
    await expect(
      broker.invoke(call("get_qa_report", { jobId: "job-qa" })),
    ).resolves.toMatchObject({ jobId: "job-qa", qaArtifactId: "art-qa" });
  });

  it("fails closed when contact sheet identity does not match the bound project", async () => {
    const { broker } = build();
    await expectFailure(
      broker.invoke(call("get_contact_sheet", { assetId: "asset-0", contentHash: HASH_B })),
      "ASSET_NOT_FOUND",
    );
  });

  it("validates proposals through the store before answering valid", async () => {
    const { broker, spies } = build();
    await expect(
      broker.invoke(call("validate_edit_plan", draft(PROJECT) as unknown as Record<string, unknown>)),
    ).resolves.toEqual({ valid: true });
    expect(spies.plans.validateProposal).toHaveBeenCalledWith(draft(PROJECT), principal);
  });

  it("derives a stable request id from project, principal, run and tool call", async () => {
    const { broker, spies } = build();
    await broker.invoke(call("estimate_timeline", draft(PROJECT) as unknown as Record<string, unknown>));
    await broker.invoke(call("estimate_timeline", draft(PROJECT) as unknown as Record<string, unknown>));
    const first = spies.plans.estimateTimeline.mock.calls[0][0] as unknown as { requestId: string };
    const second = spies.plans.estimateTimeline.mock.calls[1][0] as unknown as { requestId: string };
    expect(first.requestId).toBe(second.requestId);
    expect(first.requestId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds submitted plans to the run and tool call", async () => {
    const { broker, spies } = build();
    await broker.invoke(call("submit_edit_plan", draft(PROJECT) as unknown as Record<string, unknown>, "call-9"));
    const input = spies.plans.createPlan.mock.calls[0][0] as unknown as {
      runId: string;
      toolCallId: string;
      draft: EditPlanDraftV1;
      principal: typeof principal;
    };
    expect(input.runId).toBe(RUN);
    expect(input.toolCallId).toBe("call-9");
    expect(input.draft.projectId).toBe(PROJECT);
    expect(input.principal).toEqual(principal);
  });
});

it("dispatches every declared tool with the session-bound project and principal", async () => {
  const { broker, spies } = build();
  const project = { projectId: PROJECT };
  const asset = { assetId: "asset-0", contentHash: HASH };
  const job = { jobId: "job-qa" };
  const plan = { planId: "plan-0" };
  const d = draft(PROJECT);
  const cases = {
    get_project_snapshot: [project, spies.getProjectSnapshot],
    get_asset_metadata: [asset, spies.projects.plannerAssetMetadata],
    get_job_status: [job, spies.getJob],
    list_artifacts: [job, spies.jobs.listArtifacts],
    get_object_edits: [project, spies.listObjectEdits],
    validate_edit_plan: [d, spies.plans.validateProposal],
    estimate_timeline: [plan, spies.plans.estimateTimeline],
    submit_edit_plan: [d, spies.plans.createPlan],
    get_contact_sheet: [asset, spies.getProjectSnapshot],
    get_qa_report: [job, spies.getJob],
    get_analysis: [asset, spies.jobs.analysisSummary],
    get_plan: [plan, spies.getPlan],
    get_scene_cuts: [asset, spies.sceneCuts],
    get_waveform: [asset, spies.waveform],
    get_planning_run: [project, spies.jobs.runLifecycle],
    diff_plans: [{ ...plan, draft: d }, spies.getProjectSnapshot],
    get_qa_summary: [job, spies.qaSummary],
  } as const;
  expect(Object.keys(cases).sort()).toEqual(VideoToolCallSchema.options.map(o => o.shape.tool.value).sort());
  for (const [name, [args, handler]] of Object.entries(cases)) {
    handler.mockClear();
    await broker.invoke(call(name, args));
    const seen = JSON.stringify(handler.mock.calls[0]);
    expect(seen).toContain(JSON.stringify(PROJECT));
    expect(seen).toContain(JSON.stringify(principal));
  }
});
