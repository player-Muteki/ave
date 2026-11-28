import { editorFailure } from "@ave/contracts";
import type { OpenAiToolDefinition } from "./tool-schemas.js";

export type PlannerMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface PlannerToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface PlannerCompletionResult {
  content: string | null;
  toolCalls: PlannerToolCall[];
}

export interface PlannerProvider {
  complete(
    messages: PlannerMessage[],
    tools: readonly OpenAiToolDefinition[],
    signal: AbortSignal,
  ): Promise<PlannerCompletionResult>;
}

/**
 * Bound conversation context sent to the model provider so long multi-turn
 * runs never exceed memory/context limits or leak raw pixel buffers.
 */
export function enforceContextBudget(
  messages: PlannerMessage[],
  maxMessages = 32,
  maxToolResultChars = 16_000,
): PlannerMessage[] {
  const truncated = messages.map((msg) => {
    if (msg.role === "tool" && msg.content.length > maxToolResultChars) {
      return {
        ...msg,
        content: msg.content.slice(0, maxToolResultChars) + "\n...[truncated by planner budget]",
      };
    }
    return msg;
  });

  if (truncated.length <= maxMessages) return truncated;

  // The loop starts with one system message and one user snapshot. Every tool
  // response in the retained suffix must still follow its assistant request.
  const head = truncated.slice(0, Math.max(0, Math.min(2, maxMessages)));
  let start = truncated.length - (maxMessages - head.length);
  while (truncated[start]?.role === "tool") start++;
  return head.concat(truncated.slice(start));
}

export interface OpenAiProviderOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

/**
 * Single strict JSON-Schema tool-calling provider client (OpenAI-compatible
 * `/v1/chat/completions` endpoint).
 */
export class OpenAiCompatibleProvider implements PlannerProvider {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiProviderOptions) {
    const trimmed = options.baseUrl.replace(/\/+$/, "");
    this.endpoint = trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async complete(
    messages: PlannerMessage[],
    tools: readonly OpenAiToolDefinition[],
    signal: AbortSignal,
  ): Promise<PlannerCompletionResult> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.timeoutMs);
    const onAbort = () => timeoutController.abort();
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (this.apiKey) {
        headers.authorization = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0,
        }),
        signal: timeoutController.signal,
      });

      const body = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
      if (!res.ok) {
        const msg = body?.error?.message ?? `Provider HTTP ${res.status}`;
        editorFailure("UPSTREAM_UNAVAILABLE", msg, res.status >= 500 || res.status === 429);
      }
      const msg = body?.choices?.[0]?.message;
      if (!msg) {
        editorFailure("WORKER_FAILED", "Model response did not include a choice message");
      }
      const toolCalls: PlannerToolCall[] = [];
      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== "function" || !tc.id || !tc.function?.name) {
          editorFailure("INVALID_ARGUMENT", "Malformed tool call in model response");
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          argumentsJson: tc.function.arguments ?? "{}",
        });
      }
      return {
        content: msg.content ?? null,
        toolCalls,
      };
    } catch (error) {
      if (signal.aborted) {
        editorFailure("CANCELLED", "Planning run aborted");
      }
      if (error instanceof Error && error.name === "EditorError") {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        editorFailure("UPSTREAM_UNAVAILABLE", "Model request timed out", true);
      }
      editorFailure(
        "UPSTREAM_UNAVAILABLE",
        error instanceof Error ? error.message : "Planner provider request failed",
        true,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
