import {
  EstimateTimelineModelParameters,
  VideoToolCallSchema,
  editorFailure,
} from "@ave/contracts";
import { z } from "zod";
import { sha256Hex, type VideoToolCall } from "./ipc.js";

export const ALLOWED_PLANNER_TOOLS = [
  "get_project_snapshot",
  "get_asset_metadata",
  "get_job_status",
  "list_artifacts",
  "get_object_edits",
  "validate_edit_plan",
  "estimate_timeline",
  "submit_edit_plan",
  "get_contact_sheet",
  "get_qa_report",
  "get_analysis",
  "get_plan",
  "get_scene_cuts",
  "get_waveform",
  "get_planning_run",
  "diff_plans",
  "get_qa_summary",
] as const;

export type AllowedPlannerTool = (typeof ALLOWED_PLANNER_TOOLS)[number];
const ALLOWED_TOOL_SET = new Set<string>(ALLOWED_PLANNER_TOOLS);

export const PLANNER_TOOL_DESCRIPTIONS: Record<AllowedPlannerTool, string> = {
  get_project_snapshot: "Inspect the current project revision and immutable asset identifiers.",
  get_asset_metadata:
    "Inspect stream IDs and timing for an identified project asset. Duration is derived from streams and PTS/timeBase.",
  get_job_status: "Inspect the daemon-recorded state of a project job.",
  list_artifacts: "List bounded artifact metadata for a job in this project.",
  get_object_edits:
    "Inspect copilot object-edit workflows, candidate targets, decisions, masks and QA state in this project.",
  validate_edit_plan: "Validate a proposed EditPlan draft without saving or executing it.",
  estimate_timeline:
    "Estimate duration and validation issues. Supply only planId for a saved plan, or all fields of an edit-plan draft without planId.",
  submit_edit_plan:
    "Submit an edit proposal for human approval and terminate. Does NOT approve, render, or export.",
  get_contact_sheet:
    "Bounded contact-sheet metadata for one asset (streams, index hash). Never returns raw pixels.",
  get_qa_report:
    "Read the daemon QA artifact reference for a job: state, revision, and qa hash.",
  get_analysis:
    "Latest analysis job metadata for one asset: state, sampling rate, and artifact references.",
  get_plan: "Read a previously accepted edit plan by planId (full operation list). Read-only.",
  get_scene_cuts:
    "Frame-aligned scene-cut suggestions for one asset from the deterministic FFmpeg scene-score pass.",
  get_waveform: "Inspect bounded RMS waveform buckets for the asset audio stream.",
  get_planning_run:
    "Read-only lifecycle state and recent persisted events of this planning run.",
  diff_plans:
    "Field-level diff between an accepted plan (planId) and a candidate draft before submitting. Read-only.",
  get_qa_summary:
    "Bounded QA summary of a rendered job (streams, duration, loudness, recipe/plan hashes, gates).",
};

export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: AllowedPlannerTool;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const OPTION_BY_TOOL = new Map<
  AllowedPlannerTool,
  (typeof VideoToolCallSchema.options)[number]
>();

export const PLANNER_OPENAI_TOOLS: readonly OpenAiToolDefinition[] = VideoToolCallSchema.options.map(
  (option) => {
    const name = option.shape.tool.value as AllowedPlannerTool;
    OPTION_BY_TOOL.set(name, option);
    const schemaForModel =
      name === "estimate_timeline" ? EstimateTimelineModelParameters : option.shape.args;
    const parameters = z.toJSONSchema(schemaForModel, { io: "input" }) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function" as const,
      function: {
        name,
        description: PLANNER_TOOL_DESCRIPTIONS[name],
        parameters,
      },
    };
  },
);

/**
 * Remove `null` values emitted by strict JSON-Schema providers for optional Zod fields.
 */
export function stripNulls(value: unknown, schema?: z.core.$ZodType): unknown {
  if (schema instanceof z.ZodOptional) {
    if (value === null && !schema.safeParse(null).success) return undefined;
    return stripNulls(value, schema.unwrap());
  }
  if (schema instanceof z.ZodDefault) {
    if (value === null) return undefined;
    return stripNulls(value, schema.unwrap());
  }
  if (Array.isArray(value)) {
    const elemSchema = schema instanceof z.ZodArray ? schema.element : undefined;
    return value.map((item) => stripNulls(item, elemSchema));
  }
  if (value && typeof value === "object") {
    const shape = schema instanceof z.ZodObject ? schema.shape : undefined;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (field === null && !shape) continue;
      const fieldSchema =
        shape && Object.hasOwn(shape, key) ? (shape[key] as z.core.$ZodType) : undefined;
      const adapted = stripNulls(field, fieldSchema);
      if (adapted !== undefined) {
        out[key] = adapted;
      }
    }
    return out;
  }
  return value;
}

/**
 * Strictly validate a model-emitted tool call against the closed 17-tool allowlist
 * and `@ave/contracts` VideoToolCallSchema.
 */
export function validateModelToolCall(
  toolName: string,
  toolCallId: string,
  rawArgs: unknown,
): VideoToolCall {
  if (!ALLOWED_TOOL_SET.has(toolName)) {
    editorFailure("PERMISSION_DENIED", `Tool "${toolName}" is not in the planner allowlist`);
  }
  const option = OPTION_BY_TOOL.get(toolName as AllowedPlannerTool);
  if (!option) {
    editorFailure("PERMISSION_DENIED", `Tool "${toolName}" is not registered`);
  }
  const normalizedArgs = stripNulls(rawArgs, option.shape.args);
  const parsed = VideoToolCallSchema.safeParse({
    protocolVersion: "1",
    toolCallId: sha256Hex(toolCallId),
    tool: toolName,
    args: normalizedArgs,
  });
  if (!parsed.success) {
    editorFailure(
      "INVALID_ARGUMENT",
      parsed.error.issues[0]?.message ?? `Invalid arguments for tool "${toolName}"`,
    );
  }
  return parsed.data;
}
