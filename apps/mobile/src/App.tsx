import React, { useState } from "react";
import type { ApprovalRequest, JobSnapshot, ProjectSnapshot } from "@ave/contracts";
import {
  MOBILE_SUPERVISOR_CAPABILITIES,
  MobileSupervisorSession,
} from "./supervisor-model.js";

function nextReqId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Mobile remote supervisor UI for Expo Android:
 * - Paired device connection (local LAN/direct auth in v1; relay optional later)
 * - Project monitor, pending approval decisions, job cancel, and verified download
 * - Desktop-only timeline editing and mask refinement remain excluded by design
 */
export function App() {
  const [wsUrl, setWsUrl] = useState("ws://127.0.0.1:4789/ws");
  const [deviceId, setDeviceId] = useState("");
  const [credential, setCredential] = useState("");
  const [session, setSession] = useState<MobileSupervisorSession | null>(null);
  const [status, setStatus] = useState("未连接桌面 daemon");
  const [projects, setProjects] = useState<Array<{ projectId: string; title: string; revision: string }>>([]);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [lastDownload, setLastDownload] = useState<string>("");

  const handleConnect = async () => {
    try {
      const next = await MobileSupervisorSession.pairAndConnect({
        url: wsUrl,
        device: { deviceId, credential },
      });
      setSession(next);
      const list = await next.listProjects();
      setProjects(list.projects);
      setStatus(`已配对连接 (${next.principal.role})`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSelectProject = async (projectId: string) => {
    if (!session) return;
    const { snapshot: snap } = await session.openProject(projectId, () => {
      void session.client.getProject(projectId).then(setSnapshot);
    });
    setSnapshot(snap);
  };

  const handleApprove = async (approval: ApprovalRequest, decision: "approve" | "reject") => {
    if (!session || !snapshot) return;
    if (decision === "approve") {
      await session.approve(approval.approvalId, snapshot.revision, nextReqId("mob-app"));
    } else {
      await session.reject(approval.approvalId, snapshot.revision, nextReqId("mob-rej"));
    }
    setSnapshot(await session.client.getProject(snapshot.projectId));
  };

  const handleCancelJob = async (job: JobSnapshot) => {
    if (!session || !snapshot) return;
    await session.cancelJob(snapshot.projectId, job.jobId, nextReqId("mob-cancel"));
    setSnapshot(await session.client.getProject(snapshot.projectId));
  };

  const handleDownload = async (job: JobSnapshot) => {
    if (!session || !snapshot) return;
    const art =
      job.artifacts.find((a) => a.kind === "export") ??
      job.artifacts.find((a) => a.kind === "candidate");
    if (!art) return;
    const { bytes, sha256 } = await session.downloadVerifiedArtifact(
      snapshot.projectId,
      art.artifactId,
      art.revision,
    );
    setLastDownload(`${art.artifactId} · ${bytes.byteLength}B · ${sha256.slice(0, 12)}`);
  };

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 640, margin: "0 auto" }}>
      <h2>AVE Android 远程监督端</h2>
      <p style={{ fontSize: 12, color: "#64748b" }}>
        模式：{MOBILE_SUPERVISOR_CAPABILITIES.timelineEditing ? "编辑" : "纯监督（预览/审批/取消/校验下载）"} · {status}
      </p>

      {!session ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input value={wsUrl} onChange={(e) => setWsUrl(e.target.value)} placeholder="Daemon WS URL" />
          <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="Device ID" />
          <input value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Credential" type="password" />
          <button onClick={() => void handleConnect()}>配对并连接</button>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {projects.map((p) => (
              <button key={p.projectId} onClick={() => void handleSelectProject(p.projectId)}>
                {p.title} (rev {p.revision})
              </button>
            ))}
          </div>

          {snapshot && (
            <div>
              <h3>待审批 ({snapshot.approvals.length})</h3>
              {snapshot.approvals.map((a) => (
                <div key={a.approvalId} style={{ padding: 8, borderBottom: "1px solid #e2e8f0" }}>
                  <div>
                    <strong>{a.purpose}</strong> · {a.status} · {a.diffSummary.summary}
                  </div>
                  {a.status === "pending" && (
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button onClick={() => void handleApprove(a, "approve")}>批准</button>
                      <button onClick={() => void handleApprove(a, "reject")}>驳回</button>
                    </div>
                  )}
                </div>
              ))}

              <h3>任务列表 ({snapshot.jobs.length})</h3>
              {snapshot.jobs.map((j) => (
                <div key={j.jobId} style={{ padding: 8, borderBottom: "1px solid #e2e8f0" }}>
                  <div>
                    <strong>{j.kind}</strong> · {j.state}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    {(j.state === "rendering_preview" || j.state === "rendering_final" || j.state === "analyzing") && (
                      <button onClick={() => void handleCancelJob(j)}>取消任务</button>
                    )}
                    {(j.state === "awaiting_review" || j.state === "awaiting_delivery_approval" || j.state === "completed") && (
                      <button onClick={() => void handleDownload(j)}>校验下载成片</button>
                    )}
                  </div>
                </div>
              ))}
              {lastDownload && <p style={{ fontSize: 12 }}>最近校验下载：{lastDownload}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
