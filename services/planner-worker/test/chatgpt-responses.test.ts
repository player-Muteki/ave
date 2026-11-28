import { afterEach, expect, it, vi } from "vitest";
import { ChatGptResponses, completedOutput } from "../src/chatgpt-responses.js";

function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    events.map((v) => "data: " + JSON.stringify(v) + "\r\n\r\n").join(""),
  );
  return new Response(
    new ReadableStream({
      start(c) {
        for (const b of bytes) c.enqueue(Uint8Array.of(b));
        c.close();
      },
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
it("only dispatches completed tool calls and retains reasoning and call IDs across turns", async () => {
  const call = {
    type: "function_call",
    name: "get_plan",
    namespace: "ave",
    call_id: "abc",
    arguments: "{}",
  };
  const reasoning = { type: "reasoning", encrypted_content: "opaque" };
  const mock = vi
    .fn()
    .mockResolvedValueOnce(
      stream([
        { type: "response.function_call_arguments.delta", delta: "{" },
        { type: "response.completed", response: { output: [reasoning, call] } },
      ]),
    )
    .mockResolvedValueOnce(
      stream([
        {
          type: "response.completed",
          response: {
            output: [{ type: "message", content: [{ text: "完成" }] }],
          },
        },
      ]),
    );
  vi.stubGlobal("fetch", mock);
  const provider = new ChatGptResponses("test", "sample", 30000);
  const signal = new AbortController().signal;
  expect(
    (await provider.complete([{ role: "system", content: "edit" }], [], signal))
      .toolCalls[0].id,
  ).toBe("abc");
  const reply = await provider.complete(
    [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "abc",
            type: "function",
            function: { name: "get_plan", arguments: "{}" },
          },
        ],
      },
      { role: "tool", name: "get_plan", tool_call_id: "abc", content: "ok" },
    ],
    [],
    signal,
  );
  expect(reply.content).toBe("完成");
  expect(JSON.parse(mock.mock.calls[1][1].body).input).toEqual([
    reasoning,
    call,
    { type: "function_call_output", call_id: "abc", output: "ok" },
  ]);
});
it("rejects an interrupted or failed response before dispatch", async () => {
  await expect(
    completedOutput(
      stream([
        { type: "response.function_call_arguments.done", arguments: "{}" },
      ]),
    ),
  ).rejects.toThrow();
  await expect(
    completedOutput(stream([{ type: "response.failed" }])),
  ).rejects.toThrow();
});
