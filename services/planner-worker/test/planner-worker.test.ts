import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_PLANNER_TOOLS,
  NativePlannerLoop,
  OpenAiCompatibleProvider,
  PLANNER_OPENAI_TOOLS,
  enforceContextBudget,
  stripNulls,
  validateModelToolCall,
  videoPlannerPromptSignature,
  type PlannerMessage,
  type PlannerProvider,
} from "../src/index.js";

describe("Native AVE planner-worker core", () => {
  it("exposes exact 17 closed planner tools matching baseline", () => {
    expect(ALLOWED_PLANNER_TOOLS).toHaveLength(17);
    const names = PLANNER_OPENAI_TOOLS.map((t) => t.function.name).sort();
    expect(names).toEqual([...ALLOWED_PLANNER_TOOLS].sort());
  });

  it("rejects forbidden shell, approval, and job tools with PERMISSION_DENIED", () => {
    for (const forbidden of ["bash", "shell", "write_file", "decide_approval", "create_job"]) {
      expect(() => validateModelToolCall(forbidden, "tc-1", {})).toThrowError(
        /allowlist|registered/,
      );
    }
  });

  it("strips strict-schema nulls and validates allowed tool arguments", () => {
    const cleaned = stripNulls({
      projectId: "proj-1",
      assetId: null,
    });
    expect(cleaned).toEqual({ projectId: "proj-1" });

    const call = validateModelToolCall("get_object_edits", "tc-2", {
      projectId: "proj-1",
      assetId: null,
    });
    expect(call.tool).toBe("get_object_edits");
    expect(call.args).toEqual({ projectId: "proj-1" });
  });

  it("fails immediately on VIDEO_PLANNER_PROMPT signature mismatch", async () => {
    const provider: PlannerProvider = {
      complete: async () => ({ content: "unused", toolCalls: [] }),
    };
    const loop = new NativePlannerLoop({
      projectId: "proj-1",
      runId: "run-1",
      sessionId: "sess-1",
      promptSignature: "0".repeat(64),
      provider,
      callTool: async () => ({}),
      onEvent: () => {},
    });
    const outcome = await loop.execute("trim 2 seconds");
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("PERMISSION_DENIED");
    }
  });

  it("enforces context message and tool-output character budgets", () => {
    const longContent = "x".repeat(500);
    const messages: PlannerMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "snapshot" },
      ...Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? { role: "assistant" as const, content: `a-${i}` }
          : { role: "tool" as const, tool_call_id: `t-${i}`, name: "get_plan", content: longContent },
      ),
    ];
    const bounded = enforceContextBudget(messages, 8, 50);
    expect(bounded.length).toBeLessThanOrEqual(8);
    expect(bounded[0]?.role).toBe("system");
    const toolMsgs = bounded.filter((m) => m.role === "tool");
    for (const tm of toolMsgs) {
      expect(tm.content.length).toBeLessThan(120);
    }
  });

  it("runs snapshot bootstrap, rejects forbidden calls, handles steer/followUp, and terminates on submit_edit_plan", async () => {
    const events: string[] = [];
    const seenToolCalls: string[] = [];
    const seenUserContents: string[] = [];
    let turn = 0;

    const provider: PlannerProvider = {
      complete: async (messages) => {
        turn += 1;
        seenUserContents.push(
          messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .join("\n"),
        );
        if (turn === 1) {
          return {
            content: null,
            toolCalls: [
              { id: "c1", name: "bash", argumentsJson: JSON.stringify({ cmd: "rm -rf /" }) },
              {
                id: "c2",
                name: "get_asset_metadata",
                argumentsJson: JSON.stringify({ assetId: "asset-1", contentHash: "a".repeat(64) }),
              },
            ],
          };
        }
        if (turn === 2) {
          return {
            content: "Need follow up details",
            toolCalls: [],
          };
        }
        return {
          content: null,
          toolCalls: [
            {
              id: "c3",
              name: "submit_edit_plan",
              argumentsJson: JSON.stringify({
                schemaVersion: "video.edit-plan/v1",
                projectId: "proj-1",
                baseTimelineRevision: "0",
                baseAssetManifestHash: "b".repeat(64),
                preferredDeterministicBackendId: "ffmpeg",
                intent: "Trim first 2 seconds",
                trimOperations: [
                  {
                    opId: "trim-1",
                    order: "1",
                    trackId: "v1",
                    clipId: "clip-1",
                    source: {
                      assetId: "asset-1",
                      assetContentHash: "a".repeat(64),
                      streamUid: "v-0",
                      probeRevision: "1",
                    },
                    sourceRange: {
                      start: { num: "0", den: "1" },
                      duration: { num: "2", den: "1" },
                    },
                    recordRange: {
                      start: { num: "0", den: "1" },
                      duration: { num: "2", den: "1" },
                    },
                  },
                ],
                transformOperations: [],
                audioOperations: [],
                transitionOperations: [],
                subtitleOperations: [],
                generationRequests: [],
                qaRequirements: [],
                externalDestinations: [],
                maxCostMicros: "0",
              }),
            },
          ],
        };
      },
    };

    const loop = new NativePlannerLoop({
      projectId: "proj-1",
      runId: "run-1",
      sessionId: "sess-1",
      promptSignature: videoPlannerPromptSignature(),
      provider,
      callTool: async (call) => {
        seenToolCalls.push(call.tool);
        if (call.tool === "submit_edit_plan") {
          return { planId: "plan-1", planHash: "c".repeat(64), status: "proposed" };
        }
        return { ok: true };
      },
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    loop.steer("Keep original audio");
    loop.followUp("Please submit now");

    const outcome = await loop.execute("Trim first 2 seconds");
    expect(outcome.status).toBe("settled");
    if (outcome.status === "settled") {
      expect(outcome.planId).toBe("plan-1");
    }
    expect(seenToolCalls).toContain("get_project_snapshot");
    expect(seenToolCalls).toContain("get_asset_metadata");
    expect(seenToolCalls).toContain("submit_edit_plan");
    expect(seenToolCalls).not.toContain("bash");
    expect(events).toContain("agent.tool_rejected");
    expect(events).toContain("agent.plan_submitted");
    expect(seenUserContents[0]).toContain("[Operator steer]: Keep original audio");
    expect(seenUserContents[2]).toContain("[Operator follow-up]: Please submit now");
  });

  it("supports aborting an active run cleanly", async () => {
    const provider: PlannerProvider = {
      complete: async (_msgs, _tools, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            },
            { once: true },
          );
        }),
    };
    const loop = new NativePlannerLoop({
      projectId: "proj-1",
      runId: "run-2",
      sessionId: "sess-2",
      promptSignature: videoPlannerPromptSignature(),
      provider,
      callTool: async () => ({}),
      onEvent: () => {},
    });
    setTimeout(() => loop.abort(), 30);
    const outcome = await loop.execute("Trim");
    expect(outcome.status).toBe("interrupted");
  });
});

it("sends closed recursive schemas for every tool and restores both estimate shapes", async () => {
  const complete = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ choices: [{ message: { content: "ok" } }] }));
  try {
    await new OpenAiCompatibleProvider({ baseUrl: "https://provider.invalid/v1", model: "recorded" })
      .complete([], PLANNER_OPENAI_TOOLS, new AbortController().signal);
    const payload = JSON.parse(String(complete.mock.calls[0]![1]!.body));
    function inspect(schema: any) {
      if (!schema || typeof schema !== "object") return;
      if (schema.type === "object") {
        expect(schema.additionalProperties).toBe(false);
        expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
      }
      Object.values(schema).forEach(inspect);
    }
    expect(payload.tools).toHaveLength(17);
    for (const tool of payload.tools) {
      expect(tool.function.strict).toBe(true);
      inspect(tool.function.parameters);
    }
    const optional = payload.tools.find((t: any) => t.function.name === "get_object_edits").function.parameters.properties.assetId;
    expect(optional.anyOf).toContainEqual({ type: "null" });
    const estimate = payload.tools.find((t: any) => t.function.name === "estimate_timeline").function.parameters;
    const nullable = Object.fromEntries(Object.keys(estimate.properties).map(key => [key, null]));
    expect(validateModelToolCall("estimate_timeline", "a", { ...nullable, planId: "saved" }).args).toEqual({ planId: "saved" });
    expect(() => validateModelToolCall("estimate_timeline", "b", { ...nullable, planId: "saved", projectId: "other" })).toThrow();
    expect(() => validateModelToolCall("get_object_edits", "c", { projectId: "p", unknown: null })).toThrow();
  } finally { complete.mockRestore(); }
});

it("keeps complete parallel tool groups across the 32-message boundary", async () => {
  let turn = 0;
  const draft = { schemaVersion: "video.edit-plan/v1", projectId: "p", baseTimelineRevision: "0",
    baseAssetManifestHash: "a".repeat(64), intent: "trim", trimOperations: [], transformOperations: [], audioOperations: [],
    transitionOperations: [], subtitleOperations: [], generationRequests: [], qaRequirements: [], maxCostMicros: "0", externalDestinations: [] };
  const outcome = await new NativePlannerLoop({
    projectId: "p", runId: "r", sessionId: "s", promptSignature: videoPlannerPromptSignature(),
    provider: { async complete(messages) {
      expect(messages.length).toBeLessThanOrEqual(32);
      let pending: string[] = [];
      for (const msg of messages) {
        if (msg.role === "tool") {
          expect(pending.shift()).toBe(msg.tool_call_id);
        } else {
          expect(pending).toEqual([]);
          if (msg.role === "assistant") pending = (msg.tool_calls ?? []).map(c => c.id);
        }
      }
      expect(pending).toEqual([]);
      turn++;
      return { content: null, toolCalls: turn < 10
        ? [0, 1, 2].map(i => ({ id: "read-" + turn + "-" + i, name: "get_project_snapshot", argumentsJson: '{"projectId":"p"}' }))
        : [{ id: "submit", name: "submit_edit_plan", argumentsJson: JSON.stringify(draft) }] };
    } },
    callTool: async call => call.tool === "submit_edit_plan" ? { planId: "saved" } : {}, onEvent: () => {},
  }).execute("trim");
  expect(outcome).toMatchObject({ status: "settled", planId: "saved" });
  expect(turn).toBe(10);
});
