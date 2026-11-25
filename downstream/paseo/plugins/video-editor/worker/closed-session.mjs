import { z } from "zod";
import { EstimateTimelineModelParameters, VideoToolCallSchema } from "../shared/contracts/v1.ts";

const prompt =
  "You are a video edit planner. Inspect project metadata and propose a structured plan. Only the human can approve rendering or delivery.";
const descriptions = {
  get_project_snapshot: "Inspect the current project revision and immutable asset identifiers.",
  get_asset_metadata: "Inspect the streams of an identified project asset.",
  get_job_status: "Inspect the daemon-recorded state of a project job.",
  validate_edit_plan: "Validate a proposed edit without saving or executing it.",
  submit_edit_plan:
    "Submit an edit proposal for human review and terminate. This does not approve, render or export.",
  get_contact_sheet:
    "Bounded contact-sheet metadata for one asset (streams, grid budget, index hash). Never returns pixels.",
  get_qa_report:
    "Read the daemon QA artifact reference for a job: state, revision and qa hash. Never infers pass/fail.",
  get_analysis:
    "Latest analysis job metadata for one asset: state, sampling rate and QA artifact reference. Never returns pixels.",
  get_plan:
    "Read a previously accepted edit plan by planId (full operation list) to build on it. Read-only.",
  get_scene_cuts:
    "Frame-aligned scene-cut suggestions for one asset from the deterministic FFmpeg scene-score pass (bounded list, no pixels).",
  get_planning_run:
    "Read-only lifecycle state and recent persisted events of this planning run (no worker internals).",
  diff_plans:
    "Field-level diff between an accepted plan (planId) and a candidate draft before submitting. Read-only.",
  list_artifacts: "List bounded artifact metadata for a job in this project.",
  estimate_timeline: "Estimate duration and validation issues. Supply only planId for a saved plan, or all fields of an edit-plan draft without planId.",
  get_waveform: "Inspect bounded RMS waveform buckets for the asset audio stream.",
  get_qa_summary:
    "Bounded QA summary of a rendered job (streams, duration, loudness, recipe/plan hashes, gates). Never returns pixels or full probe.",
};

export async function createClosedVideoPlanner(sdk, { cwd, agentDir, invoke }) {
  const extensions = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() };
  const resources = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => prompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
      throw new Error("Planner resources are sealed");
    },
    reload: async () => {},
  };
  const customTools = VideoToolCallSchema.options.map((option) => {
    const name = option.shape.tool.value;
    const parameters = z.toJSONSchema(name === "estimate_timeline" ? EstimateTimelineModelParameters : option.shape.args, { io: "input" });
    delete parameters.$schema;
    return {
      name,
      label: name,
      description: descriptions[name],
      parameters,
      executionMode: "sequential",
      constrainedSampling:
        name === "submit_edit_plan" ? { type: "json_schema", strict: "require" } : false,
      async execute(toolCallId, args) {
        const request = option.parse({ protocolVersion: "1", toolCallId, tool: name, args });
        const output = await invoke(request);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          details: output,
          ...(name === "submit_edit_plan" ? { terminate: true } : {}),
        };
      },
    };
  });
  const names = Object.keys(descriptions).sort();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    resourceLoader: resources,
    noTools: "all",
    tools: names,
    customTools,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    settingsManager: sdk.SettingsManager.inMemory({
      cacheWarming: "off",
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  });
  try {
    for (const inventory of [
      session.getActiveToolNames(),
      session.getCallableToolNames(),
      session.getAllTools().map((t) => t.name),
    ]) {
      if (JSON.stringify([...inventory].sort()) !== JSON.stringify(names))
        throw new Error("Pi planner tool inventory mismatch");
    }
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}
