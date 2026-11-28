import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AveClient } from "@ave/client-sdk";
import type {
  ModelPolicyListResultSchema,
  PlanningRunStatus,
  StartPlanningRunInput,
} from "@ave/contracts";
import type { z } from "zod";

interface AccountStatus {
  account: string | null;
  enabled: boolean;
  persistent: boolean;
  pending: boolean;
}
export interface ChatGptBridge {
  accountStatus(): Promise<AccountStatus>;
  accountLogin(): Promise<unknown>;
  accountLogout(): Promise<void>;
  accountCancel(): Promise<void>;
  accountModels(): Promise<Array<{ id: string; name: string }>>;
  accountUsage(): Promise<void>;
  accountPlan(input: StartPlanningRunInput): Promise<PlanningRunStatus>;
}
type Policies = z.infer<typeof ModelPolicyListResultSchema>;
const requestId = () => crypto.randomUUID();

export function ChatGptPanel({
  bridge,
  client,
  projectId,
  assetId,
}: {
  bridge: ChatGptBridge;
  client: AveClient | null;
  projectId?: string;
  assetId?: string;
}) {
  const [account, setAccount] = useState<AccountStatus>();
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [model, setModel] = useState("");
  const [policies, setPolicies] = useState<Policies>();
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const runKey = "ave.chatgpt.run." + projectId;
  const [run, setRun] = useState(() => sessionStorage.getItem(runKey) ?? "");
  const [running, setRunning] = useState(false);
  const [runText, setRunText] = useState("");
  const pendingRequest = useRef<
    { fingerprint: string; id: string } | undefined
  >(undefined);
  const sync = useCallback(async () => {
    const state = await bridge.accountStatus();
    if (!alive.current) return;
    setAccount(state);
    if (!state.enabled) {
      setModels([]);
      setModel("");
      return;
    }
    const list = await bridge.accountModels();
    if (!alive.current) return;
    setModels(list);
    setModel((old) =>
      list.some((m) => m.id === old) ? old : (list[0]?.id ?? ""),
    );
  }, [bridge]);
  const syncPolicy = useCallback(async () => {
    if (!client || !projectId) return;
    const result = await client.call<Policies>("video.v1.get_model_policies", {
      projectId,
      requestId: requestId(),
    });
    if (alive.current) setPolicies(result);
  }, [client, projectId]);
  const error = (err: unknown) => {
    if (alive.current)
      setNotice(err instanceof Error ? err.message : String(err));
  };
  useEffect(() => {
    alive.current = true;
    void sync().catch(error);
    void syncPolicy().catch(error);
    return () => {
      alive.current = false;
    };
  }, [sync, syncPolicy]);
  useEffect(() => {
    if (!client || !projectId || !run) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let afterSeq = "0";
    async function poll() {
      try {
        const status = await client!.call<PlanningRunStatus>(
          "video.v1.get_planning_run",
          { projectId, runId: run },
        );
        const page = await client!.call<{
          events: Array<{
            seq: string;
            type: string;
            payload: {
              detail?: string;
              planId?: string;
              error?: { sanitizedDetail?: string };
            };
          }>;
        }>("video.v1.get_run_events", {
          projectId,
          runId: run,
          requestId: requestId(),
          afterSeq,
        });
        if (disposed) return;
        const active = ["running", "awaiting_input"].includes(status.state);
        const terminal = page.events.findLast((e) =>
          ["run.settled", "run.failed", "run.interrupted"].includes(e.type),
        );
        const detail = terminal?.payload;
        if (page.events.length) afterSeq = page.events.at(-1)!.seq;
        setRunning(active);
        setRunText(
          detail?.planId
            ? "方案已提交审批 · " + detail.planId
            : (detail?.error?.sanitizedDetail ??
                detail?.detail ??
                {
                  running: "AI 正在规划",
                  awaiting_input: "等待输入",
                  settled: "规划已结束",
                  failed: "规划失败",
                  interrupted: "规划已停止",
                }[status.state]),
        );
        if (active || (!terminal && page.events.length))
          timer = setTimeout(poll, 800);
      } catch (err) {
        if (!disposed) {
          error(err);
          timer = setTimeout(poll, 2500);
        }
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [client, projectId, run]);
  async function act(fn: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setNotice("");
    try {
      await fn();
    } catch (err) {
      error(err);
    } finally {
      busy.current = false;
      if (alive.current) setWorking(false);
    }
  }
  const enabled =
    policies?.allowCloudModels &&
    policies.policies.some(
      (p) =>
        p.provider === "chatgpt" &&
        p.modelId === model &&
        p.enabled &&
        p.location === "cloud" &&
        p.stages.includes("planning"),
    );
  return (
    <section
      style={{
        background: "var(--panel)",
        padding: 14,
        marginBottom: 14,
        borderRadius: 10,
      }}
    >
      <h3>设置 · AI 模型</h3>
      <p>
        {account?.account ?? "尚未登录 ChatGPT"}
        {account?.account &&
          (account.enabled
            ? " · 已授权使用 ChatGPT 套餐"
            : " · 尚未授权使用套餐")}
        {account &&
          !account.persistent &&
          " · 仅本次使用，关闭应用后需重新登录"}
      </p>
      {!account?.enabled && (
        <button
          disabled={working}
          onClick={() =>
            void act(async () => {
              setAccount((old) => old && { ...old, pending: true });
              try {
                await bridge.accountLogin();
              } finally {
                await sync();
              }
              if ((await bridge.accountStatus()).enabled)
                setNotice("符合条件的 AI 请求将使用你的 ChatGPT 套餐。");
            })
          }
        >
          {account?.account ? "授权使用套餐" : "使用 ChatGPT 继续"}
        </button>
      )}
      {account?.pending && (
        <button onClick={() => void bridge.accountCancel().catch(error)}>
          取消登录
        </button>
      )}
      {account?.account && (
        <button
          disabled={working}
          onClick={() =>
            void act(async () => {
              try {
                await bridge.accountLogout();
              } finally {
                await sync();
              }
            })
          }
        >
          退出账号
        </button>
      )}
      {account?.enabled && (
        <>
          <label>
            {" "}
            使用 ChatGPT 套餐 · 模型{" "}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <button disabled={working} onClick={() => void act(sync)}>
            刷新模型
          </button>
          <button onClick={() => void bridge.accountUsage().catch(error)}>
            管理用量
          </button>
          {!models.length && <p>当前账号没有可用模型，或模型列表尚未加载。</p>}
          {projectId && model && !enabled && (
            <button
              disabled={working}
              onClick={() =>
                void act(async () => {
                  await client!.call("video.v1.set_project_cloud_policy", {
                    requestId: requestId(),
                    projectId,
                    allowCloudModels: true,
                  });
                  await client!.call("video.v1.set_model_policy", {
                    requestId: requestId(),
                    projectId,
                    policy: {
                      provider: "chatgpt",
                      modelId: model,
                      stages: ["planning"],
                      enabled: true,
                      location: "cloud",
                    },
                  });
                  await syncPolicy();
                })
              }
            >
              允许此项目使用所选云模型
            </button>
          )}
        </>
      )}
      {projectId && (
        <div>
          <label>
            告诉 AI 怎么剪{" "}
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="只保留开头两秒，并把这段静音"
            />
          </label>
          <button
            disabled={
              working ||
              running ||
              !account?.enabled ||
              !enabled ||
              !assetId ||
              !prompt.trim()
            }
            onClick={() =>
              void act(async () => {
                const fingerprint = JSON.stringify([
                  projectId,
                  assetId,
                  model,
                  prompt,
                ]);
                if (pendingRequest.current?.fingerprint !== fingerprint)
                  pendingRequest.current = { fingerprint, id: requestId() };
                const result = await bridge.accountPlan({
                  requestId: pendingRequest.current.id,
                  projectId,
                  model: { provider: "chatgpt", id: model },
                  prompt: "当前选中素材 ID：" + assetId + "\n" + prompt.trim(),
                });
                sessionStorage.setItem(runKey, result.runId);
                pendingRequest.current = undefined;
                setRun(result.runId);
                setRunning(true);
              })
            }
          >
            生成剪辑方案
          </button>
          {running && (
            <button
              onClick={() =>
                void act(async () => {
                  await client!.call("video.v1.stop_planning_run", {
                    projectId,
                    runId: run,
                  });
                })
              }
            >
              停止规划
            </button>
          )}
          {account?.enabled && (
            <p>将向所选模型发送指令、项目元数据与工具结果。源视频留在本机。</p>
          )}
          {runText && <p role="status">{runText}</p>}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
