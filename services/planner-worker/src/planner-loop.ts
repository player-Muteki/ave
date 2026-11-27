import { randomUUID } from "node:crypto";
import {
  describeEditorError,
  editorFailure,
  type EditorEvent,
} from "@ave/contracts";
import { sha256Hex, type VideoToolCall } from "./ipc.js";
import { VIDEO_PLANNER_PROMPT, videoPlannerPromptSignature } from "./prompt.js";
import { enforceContextBudget, type PlannerMessage, type PlannerProvider } from "./provider.js";
import { PLANNER_OPENAI_TOOLS, validateModelToolCall } from "./tool-schemas.js";

export type PlannerLoopOutcome =
  | { status: "settled"; summary: string; planId?: string; planHash?: string }
  | { status: "interrupted"; reason: string }
  | { status: "failed"; error: { code: string; retryable: boolean; sanitizedDetail: string } };

export interface PlannerLoopOptions {
  projectId: string;
  runId: string;
  sessionId: string;
  promptSignature: string;
  provider: PlannerProvider;
  maxTurns?: number;
  maxToolResultChars?: number;
  maxMessages?: number;
  callTool: (call: VideoToolCall) => Promise<unknown>;
  onEvent: (event: EditorEvent) => void;
}

/**
 * Native AVE planning state loop replacing the external Pi SDK.
 * Fetches a bounded canonical project snapshot, iterates model tool calls
 * through daemon-verified tools, supports steer/followUp/abort, and terminates
 * cleanly upon `submit_edit_plan` without ever approving or rendering.
 */
export class NativePlannerLoop {
  private readonly steerQueue: string[] = [];
  private readonly followUpQueue: string[] = [];
  private readonly abortController = new AbortController();
  private seq = 0;

  constructor(private readonly options: PlannerLoopOptions) {}

  steer(text: string): void {
    this.steerQueue.push(text);
  }

  followUp(text: string): void {
    this.followUpQueue.push(text);
  }

  abort(): void {
    this.abortController.abort();
  }

  private emit(type: string, payload: unknown, causationId?: string): void {
    this.seq += 1;
    this.options.onEvent({
      protocolVersion: "1",
      projectId: this.options.projectId,
      sessionId: this.options.sessionId,
      runId: this.options.runId,
      eventId: randomUUID(),
      seq: String(this.seq),
      ...(causationId ? { causationId } : {}),
      occurredAt: new Date().toISOString(),
      type: type.startsWith("agent.") ? type : `agent.${type}`,
      payload,
    });
  }

  private async fetchCanonicalSnapshot(tag: string): Promise<unknown> {
    return this.options.callTool({
      protocolVersion: "1",
      toolCallId: sha256Hex(`${this.options.runId}:snapshot:${tag}:${this.seq}`),
      tool: "get_project_snapshot",
      args: { projectId: this.options.projectId },
    });
  }

  async execute(userPrompt: string): Promise<PlannerLoopOutcome> {
    const maxTurns = this.options.maxTurns ?? 12;
    const maxMessages = this.options.maxMessages ?? 32;
    const maxToolResultChars = this.options.maxToolResultChars ?? 16_000;

    try {
      if (this.options.promptSignature !== videoPlannerPromptSignature()) {
        editorFailure("PERMISSION_DENIED", "VIDEO_PLANNER_PROMPT signature mismatch");
      }

      const initialSnapshot = await this.fetchCanonicalSnapshot("init");
      if (this.abortController.signal.aborted) {
        return { status: "interrupted", reason: "aborted before first model turn" };
      }

      const messages: PlannerMessage[] = [
        { role: "system", content: VIDEO_PLANNER_PROMPT },
        {
          role: "user",
          content:
            `The daemon bound this planning run to projectId "${this.options.projectId}".\n\n` +
            `Canonical project snapshot:\n${JSON.stringify(initialSnapshot)}\n\n` +
            `User edit request:\n${userPrompt}`,
        },
      ];

      for (let turn = 1; turn <= maxTurns; turn += 1) {
        if (this.abortController.signal.aborted) {
          return { status: "interrupted", reason: "aborted by operator" };
        }

        while (this.steerQueue.length > 0) {
          const text = this.steerQueue.shift()!;
          messages.push({ role: "user", content: `[Operator steer]: ${text}` });
        }

        const bounded = enforceContextBudget(messages, maxMessages, maxToolResultChars);
        const completion = await this.options.provider.complete(
          bounded,
          PLANNER_OPENAI_TOOLS,
          this.abortController.signal,
        );

        this.emit("agent.turn", {
          turn,
          hasContent: Boolean(completion.content),
          toolCallCount: completion.toolCalls.length,
        });

        messages.push({
          role: "assistant",
          content: completion.content,
          ...(completion.toolCalls.length > 0
            ? {
                tool_calls: completion.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.name, arguments: tc.argumentsJson },
                })),
              }
            : {}),
        });

        if (completion.toolCalls.length === 0) {
          if (this.followUpQueue.length > 0) {
            const followUpText = this.followUpQueue.shift()!;
            const refreshed = await this.fetchCanonicalSnapshot(`followup-${turn}`);
            messages.push({
              role: "user",
              content:
                `[Operator follow-up]: ${followUpText}\n\n` +
                `Canonical project snapshot:\n${JSON.stringify(refreshed)}`,
            });
            continue;
          }
          const summary = completion.content ?? "Planning completed without plan submission";
          this.emit("agent.end", { turn, submitted: false });
          return { status: "settled", summary };
        }

        for (const tc of completion.toolCalls) {
          if (this.abortController.signal.aborted) {
            return { status: "interrupted", reason: "aborted during tool loop" };
          }
          const causationId = sha256Hex(tc.id);
          this.emit("agent.tool_execution_start", { tool: tc.name }, causationId);

          let rawArgs: unknown;
          try {
            rawArgs = JSON.parse(tc.argumentsJson);
          } catch {
            const err = { code: "INVALID_ARGUMENT", message: "Tool arguments are not valid JSON" };
            this.emit("agent.tool_rejected", { tool: tc.name, reason: err.code }, causationId);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.name,
              content: JSON.stringify({ ok: false, error: err }),
            });
            continue;
          }

          let validated: VideoToolCall;
          try {
            validated = validateModelToolCall(tc.name, tc.id, rawArgs);
          } catch (error) {
            const detail = describeEditorError(error);
            this.emit("agent.tool_rejected", { tool: tc.name, reason: detail.code }, causationId);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: tc.name,
              content: JSON.stringify({
                ok: false,
                error: { code: detail.code, message: detail.sanitizedDetail },
              }),
            });
            continue;
          }

          try {
            const output = await this.options.callTool(validated);
            this.emit("agent.tool_execution_end", { tool: validated.tool, ok: true }, causationId);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: validated.tool,
              content: JSON.stringify(output),
            });

            if (validated.tool === "submit_edit_plan") {
              const submitted = (output ?? {}) as { planId?: string; planHash?: string };
              this.emit(
                "agent.plan_submitted",
                { planId: submitted.planId, planHash: submitted.planHash },
                causationId,
              );
              this.emit("agent.end", { turn, submitted: true }, causationId);
              return {
                status: "settled",
                summary: `Submitted edit plan ${submitted.planId ?? ""} for human approval`.trim(),
                planId: submitted.planId,
                planHash: submitted.planHash,
              };
            }
          } catch (error) {
            if (this.abortController.signal.aborted) {
              return { status: "interrupted", reason: "aborted waiting for tool call" };
            }
            const detail = describeEditorError(error);
            this.emit(
              "agent.tool_execution_end",
              { tool: validated.tool, ok: false, code: detail.code },
              causationId,
            );
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              name: validated.tool,
              content: JSON.stringify({
                ok: false,
                error: { code: detail.code, message: detail.sanitizedDetail },
              }),
            });
          }
        }
      }

      return {
        status: "failed",
        error: {
          code: "RESOURCE_EXHAUSTED",
          retryable: false,
          sanitizedDetail: `Planner exceeded maxTurns budget (${maxTurns})`,
        },
      };
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return { status: "interrupted", reason: "aborted by operator" };
      }
      return {
        status: "failed",
        error: describeEditorError(error),
      };
    }
  }
}
