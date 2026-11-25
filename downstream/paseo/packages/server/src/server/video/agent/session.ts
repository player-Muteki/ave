import { createAgentSession, SessionManager, SettingsManager, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { VideoToolCallSchema, type EditorEvent } from "#video-editor/contracts/v1";
import { randomUUID } from "node:crypto";
import { VIDEO_PLANNER_PROMPT, videoPlannerPromptSignature } from "./prompt.js";
import { newRequestId, type DaemonToWorker, type IpcChannel, type WorkerToDaemon } from "./ipc.js";

export interface PlannerSessionOptions {
  projectId: string;
  runId: string;
  sessionId: string;
  workspace: string;
  /** SHA-256 of VIDEO_PLANNER_PROMPT supplied by the daemon at init. */
  promptSignature: string;
  channel: IpcChannel<DaemonToWorker, WorkerToDaemon>;
  onEvent: (event: EditorEvent) => void;
}

interface PiSession {
  prompt(text: string): Promise<unknown>;
  steer(text: string): Promise<unknown>;
  followUp(text: string): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: unknown) => void): void;
  getActiveToolNames(): string[];
  getCallableToolNames(): string[];
  getAllTools(): Array<{ name: string }>;
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
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
};

/**
 * Create the locked-down planner session (same construction as the vetted
 * worker/closed-session.mjs probe): noTools:"all" plus only the closed
 * customTools set derived from VideoToolCallSchema; sealed ResourceLoader with
 * no extensions/skills/themes/prompts/agents files/MCP; pinned system prompt
 * verified against the daemon-supplied signature; in-memory session/settings
 * managers (the daemon owns durable state, the worker owns none). The worker
 * cwd is a host-owned empty workspace, never the source or asset root.
 */
export async function createPlannerSession(options: PlannerSessionOptions) {
  if (options.promptSignature !== videoPlannerPromptSignature()) {
    throw new Error("VIDEO_PLANNER_PROMPT signature mismatch; refusing to start the worker");
  }

  const invoke = async (call: z.infer<typeof VideoToolCallSchema>) => {
    const reply = (await options.channel.request({
      kind: "tool_call",
      requestId: newRequestId(),
      call,
    })) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (!reply.ok) {
      const error = new Error(reply.error?.message ?? "tool call failed");
      (error as Error & { code?: string }).code = reply.error?.code ?? "TOOL_FAILED";
      throw error;
    }
    return reply.result;
  };

  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const resources = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => VIDEO_PLANNER_PROMPT,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
      throw new Error("Planner resources are sealed");
    },
    reload: async () => {},
  };

  const customTools = VideoToolCallSchema.options.map((option) => {
    const name = option.shape.tool.value as string;
    const parameters = z.toJSONSchema(option.shape.args, { io: "input" });
    delete (parameters as Record<string, unknown>).$schema;
    return {
      name,
      label: name,
      description: TOOL_DESCRIPTIONS[name],
      parameters,
      executionMode: "sequential" as const,
      constrainedSampling:
        name === "submit_edit_plan" ? { type: "json_schema" as const, strict: "require" as const } : false as const,
      async execute(toolCallId: string, args: unknown) {
        const request = option.parse({ protocolVersion: "1", toolCallId, tool: name, args });
        const output = await invoke(request);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          details: output,
          ...(name === "submit_edit_plan" ? { terminate: true } : {}),
        };
      },
    };
  });
  const names = Object.keys(TOOL_DESCRIPTIONS).sort();

  const { session } = (await createAgentSession({
    cwd: options.workspace,
    agentDir: options.workspace,
    resourceLoader: resources,
    noTools: "all",
    tools: names,
    customTools,
    sessionManager: SessionManager.inMemory(options.workspace),
    settingsManager: SettingsManager.inMemory({
      cacheWarming: "off",
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  })) as unknown as { session: PiSession };

  for (const inventory of [
    session.getActiveToolNames(),
    session.getCallableToolNames(),
    session.getAllTools().map((t) => t.name),
  ]) {
    if (JSON.stringify([...inventory].sort()) !== JSON.stringify(names)) {
      await session.dispose();
      throw new Error("Pi planner tool inventory mismatch");
    }
  }

  let seq = 0;
  session.subscribe((piEvent: unknown) => {
    const e = piEvent as { type?: string; id?: string; toolCallId?: string };
    const type = typeof e?.type === "string" ? e.type : "agent.unknown";
    if (type === "tool_execution_start" || type === "message_end" || type === "agent_end") {
      seq += 1;
      options.onEvent({
        protocolVersion: "1",
        projectId: options.projectId,
        sessionId: options.sessionId,
        runId: options.runId,
        eventId: typeof e?.id === "string" ? e.id : randomUUID(),
        seq: String(seq),
        causationId: typeof e?.toolCallId === "string" ? e.toolCallId : undefined,
        occurredAt: new Date().toISOString(),
        type: `agent.${type}`,
        payload: {},
      });
    }
  });

  return {
    session,
    prompt: (text: string) => session.prompt(text),
    steer: (text: string) => session.steer(text),
    followUp: (text: string) => session.followUp(text),
    abort: () => session.abort(),
    dispose: async () => session.dispose(),
  };
}
