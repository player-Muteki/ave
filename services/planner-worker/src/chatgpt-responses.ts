import { editorFailure } from "@ave/contracts";
import type {
  PlannerCompletionResult,
  PlannerMessage,
  PlannerProvider,
} from "./provider.js";
import type { OpenAiToolDefinition } from "./tool-schemas.js";

interface OutputItem {
  type: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  call_id?: string;
  content?: Array<{ type: string; text?: string; refusal?: string }>;
}

// Only a completed response can dispatch tools. Its output contains the assembled
// arguments, even when individual SSE deltas split a UTF-8 character.
export async function completedOutput(
  response: Response,
): Promise<OutputItem[]> {
  if (!response.body) throw new Error("模型响应缺少事件流");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += value ?? "";
      size += value?.length ?? 0;
      if (size > 16_000_000) throw new Error("模型响应超过限制");
      if (done) buffer += "\n\n";
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((s) => s.startsWith("data:"))
          .map((s) => s.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (
          event.type === "response.completed" &&
          Array.isArray(event.response?.output)
        )
          return event.response.output;
        if (
          ["response.failed", "response.incomplete", "error"].includes(
            event.type,
          )
        )
          throw new Error("模型未完成本轮响应");
      }
      if (done) throw new Error("模型连接在响应完成前中断");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ChatGptResponses implements PlannerProvider {
  private readonly history = new Map<string, OutputItem[]>();
  private readonly executed = new Set<string>();
  constructor(
    private token: string,
    private model: string,
    private timeout: number,
  ) {}
  async complete(
    messages: PlannerMessage[],
    tools: readonly OpenAiToolDefinition[],
    signal: AbortSignal,
  ): Promise<PlannerCompletionResult> {
    const input: unknown[] = [];
    let instructions = "";
    for (const m of messages) {
      if (m.role === "system") instructions += m.content + "\n";
      else if (m.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: m.content,
        });
      else if (m.role === "assistant" && m.tool_calls?.length) {
        const items = this.history.get(m.tool_calls[0].id);
        if (!items) throw new Error("缺少上一轮工具调用记录");
        input.push(...items);
      } else if (m.content) input.push({ role: m.role, content: m.content });
    }
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + this.token,
        "content-type": "application/json",
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeout)]),
      body: JSON.stringify({
        model: this.model,
        instructions,
        input,
        store: false,
        stream: true,
        include: ["reasoning.encrypted_content"],
        tools: [
          {
            type: "namespace",
            name: "ave",
            description: "AVE project inspection and edit proposals",
            tools: tools.map((t) => ({ type: "function", ...t.function })),
          },
        ],
      }),
    });
    if (!res.ok) {
      const detail =
        res.status === 429
          ? "ChatGPT 用量或频率已达上限"
          : res.status === 401
            ? "请重新登录 ChatGPT"
            : "ChatGPT 模型请求失败";
      editorFailure(
        "UPSTREAM_UNAVAILABLE",
        detail + " (HTTP " + res.status + ")",
        res.status >= 500 || res.status === 429,
      );
    }
    const output = await completedOutput(res);
    const toolCalls = [];
    let content = "";
    for (const item of output) {
      if (item.type === "message")
        for (const part of item.content ?? [])
          content += part.text ?? part.refusal ?? "";
      if (item.type !== "function_call") continue;
      if (
        (item.namespace && item.namespace !== "ave") ||
        !item.call_id ||
        !item.name ||
        typeof item.arguments !== "string" ||
        this.executed.has(item.call_id)
      )
        throw new Error("无效或重复的工具调用");
      this.executed.add(item.call_id);
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        argumentsJson: item.arguments,
      });
    }
    if (toolCalls.length) this.history.set(toolCalls[0].id, output);
    return { content: content || null, toolCalls };
  }
}
