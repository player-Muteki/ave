import React, { useEffect, useState } from "react";
import { AveClient, downloadArtifactBytes, sha256HexBrowserSafe } from "@ave/client-sdk";
import {
  decodeFramedChunk, InspectFrameHeaderSchema, MaskAnchorRevisionSchema,
  type JobSnapshot, type ObjectCandidate, type ObjectDecision, type ObjectEditWorkflow, type ProjectSnapshot,
} from "@ave/contracts";
import { formatError } from "./workbench-state.js";

interface MediaProps {
  client: AveClient; projectId: string; id: string; kind: "frame" | "anchor" | "sequence";
  sourceHash: string; streamUid?: string; indexHash?: string; frame?: number; box?: ObjectCandidate["box"];
  revision?: string; hash?: string; onViewed?: (key: string) => void;
}

function ReviewMedia({ client, projectId, id, kind, sourceHash, streamUid, indexHash, frame, revision, hash, box, onViewed }: MediaProps) {
  const [media, setMedia] = useState<{ id: string; url: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true, url = "";
    setMedia(undefined);
    setError("");
    async function load() {
      let bytes: Uint8Array;
      if (kind === "sequence") {
        const result = await downloadArtifactBytes(client, { projectId, assetId: id, revision: revision! });
        if (result.sha256 !== hash) throw new Error("审片视频哈希不匹配");
        bytes = result.bytes;
      } else {
        const response = kind === "anchor"
          ? await client.callBinary("video.v1.get_mask_revision", { projectId, maskRevisionId: id })
          : await client.callBinary("video.v1.inspect_frame", { projectId, assetId: id, streamUid, sourcePresentationIndexHash: indexHash, frame, points: [] });
        const part = decodeFramedChunk(response);
        const header = JSON.parse(new TextDecoder().decode(part.metadata));
        const digest = await sha256HexBrowserSafe(part.payload);
        if (kind === "anchor") {
          const mask = MaskAnchorRevisionSchema.parse(header);
          if (mask.projectId !== projectId || mask.maskRevisionId !== id || mask.anchor.sourceSha256 !== sourceHash ||
              mask.reviewImage.sha256 !== digest) throw new Error("掩码审片图与当前版本不一致");
        } else {
          const h = InspectFrameHeaderSchema.parse(header);
          if (h.projectId !== projectId || h.assetId !== id || h.sourceSha256 !== sourceHash || h.frame !== frame ||
              h.streamUid !== streamUid || h.sourcePresentationIndexHash !== indexHash || h.previewSha256 !== digest) throw new Error("候选证据帧与素材不一致");
        }
        bytes = part.payload;
      }
      if (!active) return;
      url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: kind === "sequence" ? "video/mp4" : "image/jpeg" }));
      setMedia({ id, url });
    }
    void load().catch(e => { if (active) setError(formatError(e)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [client, projectId, id, kind, sourceHash, streamUid, indexHash, frame, revision, hash]);
  if (error) return <p role="alert">{error}</p>;
  if (!media || media.id !== id) return <p>正在校验审片素材…</p>;
  const ready = () => onViewed?.(id);
  return kind === "sequence"
    ? <video aria-label="追踪掩码审片" controls src={media.url} onLoadedData={ready} style={{ width: "100%" }} />
    : <div style={{ position: "relative", maxWidth: kind === "frame" ? 220 : "100%" }}>
        <img src={media.url} alt={kind === "anchor" ? "待审核的掩码叠加图" : "人物候选证据帧"} onLoad={ready} style={{ display: "block", width: "100%" }} />
        {box && <div aria-hidden style={{ position: "absolute", border: "2px solid #ffcf42", boxSizing: "border-box",
          left: box.x * 100 + "%", top: box.y * 100 + "%", width: box.width * 100 + "%", height: box.height * 100 + "%" }} />}
      </div>;
}

interface Props {
  client: AveClient; snapshot: ProjectSnapshot; workflow: ObjectEditWorkflow;
  refresh: (id: string) => Promise<void>; status: (message: string) => void;
}

export function ObjectEditPanel({ client, snapshot, workflow: wf, refresh, status }: Props) {
  const [choices, setChoices] = useState<Record<string, ObjectDecision["decision"]>>({});
  const [viewed, setViewed] = useState("");
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("移除选中的人物，保留背景和其他人物");
  const [seed, setSeed] = useState(42);
  const { projectId, workflowId, sourceFrames: span } = wf;
  const asset = snapshot.assets.find(a => a.assetId === wf.assetId);
  const anchor = snapshot.approvals.find(a => a.approvalId === wf.maskApprovalId);
  const tracks = snapshot.jobs.filter(j => wf.maskApprovalId && j.trackingAnchorId === wf.maskApprovalId);
  const track = tracks.at(-1);
  const manifest = track?.artifacts.find(a => a.kind === "mask");
  const proxy = track?.artifacts.find(a => a.kind === "proxy");
  const sequence = snapshot.approvals.findLast(a => manifest && a.subjectId === manifest.artifactId && a.subjectHash === manifest.blob.sha256);
  const expectedRevision = wf.baseTimelineRevision;
  const stale = snapshot.revision !== expectedRevision;
  const stageNames = {
    analyzing: "正在检测人物", awaiting_target_selection: "选择人物", awaiting_mask_review: "审核单帧掩码",
    awaiting_generation_review: "追踪与生成", completed: "已完成", failed: "失败",
  };
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    try { await action(); await refresh(projectId); } catch (error) { status(formatError(error)); }
    finally { setBusy(false); }
  }
  const mutation = () => ({ projectId, requestId: crypto.randomUUID(), workflowId, expectedWorkflowRevision: wf.workflowRevision });
  const review = (approved: boolean) => act(() => client.call("video.v1.review_object_mask", {
    ...mutation(), maskRevisionId: wf.maskRevisionId, approved,
  }));
  function trackMask() {
    if (!span || !anchor || wf.anchorFrame === undefined) return;
    const firstFrame = Math.max(span.firstFrame, Math.min(wf.anchorFrame - 4, span.firstFrame + span.frameCount - 9));
    return act(() => client.call<{ job: JobSnapshot }>("video.v1.track_mask", { projectId, expectedRevision,
      requestId: crypto.randomUUID(), anchorApprovalId: anchor.approvalId, anchorHash: anchor.subjectHash, firstFrame, frameCount: 9 }));
  }
  return <fieldset disabled={busy || stale} style={{ marginTop: 12, border: "1px solid var(--border)" }}>
    <legend>{asset?.displayName} · {stageNames[wf.state]}</legend>
    {stale && <p>项目版本已更新，请重新选择素材并开启对象编辑。</p>}
    {wf.error && <p role="alert">{wf.error.code} · {wf.error.sanitizedDetail}</p>}
    {wf.state === "completed" && !wf.candidates.length && <p>所选片段中未检测到人物。</p>}
    {wf.state === "awaiting_target_selection" && asset && <>
      {wf.candidates.map((c, i) => <div key={c.objectId} style={{ marginBottom: 10 }}>
        <ReviewMedia client={client} projectId={projectId} id={asset.assetId} kind="frame" sourceHash={wf.assetContentHash}
          indexHash={asset.presentationIndex.sha256} streamUid={span?.streamUid ?? asset.streams.find(s => s.kind === "video")?.streamUid}
          frame={Number(c.evidenceFrames[0])} box={c.box} />
        <label>人物 {i+1} · 源帧 {c.evidenceFrames[0]} <select aria-label={"人物 " + (i+1)} value={choices[c.objectId] ?? "skip"}
          onChange={e => setChoices({ ...choices, [c.objectId]: e.target.value as ObjectDecision["decision"] })}>
          <option value="skip">跳过</option><option value="keep">保留</option><option value="remove">移除</option>
        </select></label>
      </div>)}
      <button onClick={() => void act(() => client.call("video.v1.decide_object_target", { ...mutation(),
        decisions: wf.candidates.map(c => ({ objectId: c.objectId, decision: choices[c.objectId] ?? "skip" })) }))}>提交人物选择</button>
    </>}
    {wf.state === "awaiting_mask_review" && (wf.maskRevisionId ? <>
      <ReviewMedia client={client} projectId={projectId} id={wf.maskRevisionId} kind="anchor" sourceHash={wf.assetContentHash} onViewed={setViewed} />
      <button disabled={viewed !== wf.maskRevisionId} onClick={() => void review(true)}>批准掩码</button>
      <button disabled={viewed !== wf.maskRevisionId} onClick={() => void review(false)}>驳回并重新生成掩码</button>
    </> : <p>正在生成候选掩码…</p>)}
    {wf.state === "awaiting_generation_review" && <>
      {(!track || track.state === "failed" || track.state === "cancelled") && (span && span.frameCount >= 9
        ? <button onClick={() => void trackMask()}>追踪九帧掩码</button> : <p>所选范围不足九帧，请重新选择片段。</p>)}
      {track && !proxy && <p>{track.error?.sanitizedDetail ?? track.phaseDetail}</p>}
      {proxy && manifest && <>
        <ReviewMedia client={client} kind="sequence" projectId={projectId} id={proxy.artifactId} revision={proxy.revision}
          hash={proxy.blob.sha256} sourceHash={wf.assetContentHash} onViewed={setViewed} />
        {(!sequence || sequence.status === "expired" || sequence.status === "rejected") &&
          <button disabled={viewed !== proxy.artifactId} onClick={() => void act(() => client.call("video.v1.request_tracked_mask_review", {
            projectId, expectedRevision, requestId: crypto.randomUUID(), jobId: track!.jobId,
            manifestHash: manifest.blob.sha256, reviewHash: proxy.blob.sha256 }))}>申请整段掩码审批</button>}
        {sequence?.status === "pending" && (["approve", "reject"] as const).map(decision =>
          <button key={decision} disabled={viewed !== proxy.artifactId} onClick={() => void act(() => client.decideApproval({
            requestId: crypto.randomUUID(), expectedRevision, approvalId: sequence.approvalId, decision }))}>
            {decision === "approve" ? "批准整段掩码" : "拒绝整段掩码"}</button>)}
        {sequence?.status === "approved" && <>
          <label>生成提示 <input value={prompt} onChange={e => setPrompt(e.target.value)} /></label>
          <label>随机种子 <input type="number" min={0} max={4294967295} value={seed} onChange={e => setSeed(e.target.valueAsNumber)} /></label>
          <button disabled={!prompt.trim() || !Number.isInteger(seed) || seed < 0 || seed > 4294967295}
            onClick={() => void act(() => client.call("video.v1.propose_vace_preview", {
              projectId, expectedRevision, requestId: crypto.randomUUID(), maskApprovalId: sequence.approvalId,
              manifestHash: manifest.blob.sha256, prompt, negativePrompt: "", seed,
            }))}>提交生成方案</button>
        </>}
      </>}
    </>}
    {wf.qa && <p>残留率 {wf.qa.residualRatio} · 完整率 {wf.qa.completeRatio} · 闪烁率 {wf.qa.flickerRatio}</p>}
  </fieldset>;
}
