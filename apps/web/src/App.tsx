import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AveClient,
  SourceImport,
  createUploadChannels,
  downloadArtifactBytes,
  sha256HexBrowserSafe,
} from "@ave/client-sdk";
import type { ApprovalRequest, JobSnapshot, ProjectSnapshot } from "@ave/contracts";
import { buildSingleTrimDraft, formatError } from "./workbench-state.js";

declare global {
  interface Window {
    aveDesktop?: {
      getDaemonConfig(): Promise<{ wsUrl: string; ownerToken: string; aveHome: string }>;
      pickSourceFile(): Promise<string | null>;
    };
  }
}

function nextReqId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function App() {
  const clientRef = useRef<AveClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("正在连接本地 AVE Daemon...");
  const [projects, setProjects] = useState<Array<{ projectId: string; title: string; revision: string }>>([]);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [newTitle, setNewTitle] = useState("原生桌面剪辑项目");
  const [selectedAssetId, setSelectedAssetId] = useState<string>("");
  const [trimIntent, setTrimIntent] = useState("保留前 2 秒");
  const [startSec, setStartSec] = useState("0");
  const [durSec, setDurSec] = useState("2");
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string>("");

  const refreshProject = useCallback(async (projectId: string) => {
    const client = clientRef.current;
    if (!client) return;
    const snap = await client.getProject(projectId);
    setSnapshot(snap);
    if (!selectedAssetId && snap.assets[0]) {
      setSelectedAssetId(snap.assets[0].assetId);
    }
  }, [selectedAssetId]);

  useEffect(() => {
    let active = true;
    let unsubEvents: (() => void) | undefined;
    async function boot() {
      try {
        const cfg = window.aveDesktop
          ? await window.aveDesktop.getDaemonConfig()
          : {
              wsUrl: new URLSearchParams(window.location.search).get("wsUrl") ?? "ws://127.0.0.1:4789/ws",
              ownerToken: new URLSearchParams(window.location.search).get("token") ?? "dev-token",
              aveHome: "browser",
            };
        const client = new AveClient({ url: cfg.wsUrl, auth: { kind: "localOwner", token: cfg.ownerToken } });
        clientRef.current = client;
        client.onConnectionChange((isConn) => {
          if (active) setConnected(isConn);
        });
        await client.connect();
        if (!active) return;
        setConnected(true);
        const list = await client.listProjects();
        setProjects(list.projects);
        setStatus(`已连接 (${cfg.aveHome})`);
        if (list.projects[0]) {
          const snap = await client.getProject(list.projects[0].projectId);
          setSnapshot(snap);
          if (snap.assets[0]) setSelectedAssetId(snap.assets[0].assetId);
          unsubEvents = await client.subscribe(snap.projectId, snap.latestSeq, () => {
            void refreshProject(snap.projectId);
          });
        }
      } catch (err) {
        if (active) setStatus(`连接失败: ${formatError(err)}`);
      }
    }
    void boot();
    return () => {
      active = false;
      unsubEvents?.();
      clientRef.current?.close();
    };
  }, [refreshProject]);

  const selectedAsset = useMemo(
    () => snapshot?.assets.find((a) => a.assetId === selectedAssetId) ?? snapshot?.assets[0],
    [snapshot, selectedAssetId],
  );

  const handleCreateProject = async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const snap = await client.createProject({ requestId: nextReqId("proj"), title: newTitle });
      const list = await client.listProjects();
      setProjects(list.projects);
      setSnapshot(snap);
      await client.subscribe(snap.projectId, snap.latestSeq, () => {
        void refreshProject(snap.projectId);
      });
      setStatus(`已创建项目 ${snap.title}`);
    } catch (err) {
      setStatus(formatError(err));
    }
  };

  const handleUploadFile = async (file: File | undefined) => {
    const client = clientRef.current;
    if (!client || !snapshot || !file) return;
    try {
      const importer = new SourceImport(snapshot.projectId, file, nextReqId("upload"));
      const asset = await importer.transfer(
        createUploadChannels(client),
        sha256HexBrowserSafe,
        (bytes) => setUploadProgress(`已上传 ${bytes} / ${file.size} 字节`),
      );
      setSelectedAssetId(asset.assetId);
      setUploadProgress("");
      await refreshProject(snapshot.projectId);
      setStatus(`素材 ${asset.displayName} 导入完成`);
    } catch (err) {
      setUploadProgress("");
      setStatus(formatError(err));
    }
  };

  const handleSubmitTrimPlan = async () => {
    const client = clientRef.current;
    if (!client || !snapshot || !selectedAsset) return;
    try {
      const draft = buildSingleTrimDraft(snapshot, selectedAsset, {
        startNum: startSec,
        startDen: "1",
        durationNum: durSec,
        durationDen: "1",
        intent: trimIntent,
      });
      await client.submitPlan({
        requestId: nextReqId("plan"),
        runId: nextReqId("run"),
        toolCallId: nextReqId("tc"),
        draft,
      });
      await refreshProject(snapshot.projectId);
      setStatus("剪辑方案已提交，等待人工审批");
    } catch (err) {
      setStatus(formatError(err));
    }
  };

  const handleDecideApproval = async (approval: ApprovalRequest, decision: "approve" | "reject") => {
    const client = clientRef.current;
    if (!client || !snapshot) return;
    try {
      const res = await client.decideApproval({
        requestId: nextReqId("dec"),
        approvalId: approval.approvalId,
        expectedRevision: snapshot.revision,
        decision,
      });
      if (decision === "approve" && res.grant) {
        await client.createJob({
          requestId: nextReqId("job"),
          projectId: snapshot.projectId,
          approvalId: approval.approvalId,
          grantId: res.grant.grantId,
          expectedRevision: snapshot.revision,
        });
      }
      await refreshProject(snapshot.projectId);
      setStatus(decision === "approve" ? `已批准 ${approval.purpose} 并创建任务` : "已拒绝审批");
    } catch (err) {
      setStatus(formatError(err));
    }
  };

  const handleDownloadJobArtifact = async (job: JobSnapshot) => {
    const client = clientRef.current;
    if (!client || !snapshot) return;
    const artifact =
      job.artifacts.find((a) => a.kind === "export") ??
      job.artifacts.find((a) => a.kind === "candidate");
    if (!artifact) return;
    try {
      const { bytes } = await downloadArtifactBytes(client, {
        projectId: snapshot.projectId,
        assetId: artifact.artifactId,
        revision: artifact.revision,
      });
      const blob = new Blob([bytes.slice().buffer], { type: artifact.blob.mediaType });
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      setStatus(`已校验下载 ${artifact.artifactId} (${bytes.byteLength} 字节)`);
    } catch (err) {
      setStatus(formatError(err));
    }
  };

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>AVE 原生桌面剪辑工作台</h2>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {connected ? "● 已连接" : "○ 未连接"} · {status}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          <button onClick={() => void handleCreateProject()}>新建项目</button>
        </div>
      </header>

      {projects.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {projects.map((p) => (
            <button
              key={p.projectId}
              className={snapshot?.projectId === p.projectId ? "" : "secondary"}
              onClick={() => void refreshProject(p.projectId)}
            >
              {p.title} (rev {p.revision})
            </button>
          ))}
        </div>
      )}

      {snapshot && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <section style={{ background: "var(--panel)", padding: 14, borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ marginTop: 0 }}>1. 源素材（不可变 CAS）</h3>
            <input type="file" accept="video/*" onChange={(e) => void handleUploadFile(e.target.files?.[0])} />
            {uploadProgress && <p style={{ fontSize: 12 }}>{uploadProgress}</p>}
            <ul>
              {snapshot.assets.map((a) => (
                <li key={a.assetId} style={{ marginBottom: 6 }}>
                  <button className="secondary" onClick={() => setSelectedAssetId(a.assetId)}>
                    {a.displayName} ({a.original.bytes} B)
                  </button>
                </li>
              ))}
            </ul>
            {selectedAsset && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input value={trimIntent} onChange={(e) => setTrimIntent(e.target.value)} placeholder="剪辑意图" />
                  <input value={startSec} onChange={(e) => setStartSec(e.target.value)} style={{ width: 60 }} title="起始秒" />
                  <input value={durSec} onChange={(e) => setDurSec(e.target.value)} style={{ width: 60 }} title="时长秒" />
                  <button onClick={() => void handleSubmitTrimPlan()}>提交裁剪方案</button>
                </div>
              </div>
            )}
          </section>

          <section style={{ background: "var(--panel)", padding: 14, borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ marginTop: 0 }}>2. 审批队列 ({snapshot.approvals.length})</h3>
            {snapshot.approvals.map((a) => (
              <div key={a.approvalId} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
                <div>
                  <strong>{a.purpose}</strong> · {a.status} · {a.diffSummary.summary}
                </div>
                {a.status === "pending" && (
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button onClick={() => void handleDecideApproval(a, "approve")}>批准并执行</button>
                    <button className="secondary" onClick={() => void handleDecideApproval(a, "reject")}>拒绝</button>
                  </div>
                )}
              </div>
            ))}
          </section>

          <section style={{ background: "var(--panel)", padding: 14, borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ marginTop: 0 }}>3. 任务与交付 ({snapshot.jobs.length})</h3>
            {snapshot.jobs.map((j) => (
              <div key={j.jobId} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
                <div>
                  <strong>{j.kind}</strong> · {j.state} ({j.phaseDetail ?? ""})
                </div>
                {(j.state === "awaiting_review" || j.state === "awaiting_delivery_approval" || j.state === "completed") && (
                  <button className="secondary" style={{ marginTop: 6 }} onClick={() => void handleDownloadJobArtifact(j)}>
                    校验并加载成片
                  </button>
                )}
              </div>
            ))}
          </section>

          <section style={{ background: "var(--panel)", padding: 14, borderRadius: 10, border: "1px solid var(--border)" }}>
            <h3 style={{ marginTop: 0 }}>4. 成片审片播放器 / 对象编辑</h3>
            {previewUrl ? (
              <video src={previewUrl} controls style={{ width: "100%", borderRadius: 8 }} />
            ) : (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>尚无已校验加载的成片。</p>
            )}
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
              对象编辑工作流: {snapshot.objectEdits.length} 条
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
