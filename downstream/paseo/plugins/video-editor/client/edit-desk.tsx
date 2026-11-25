import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, useMemo, useCallback, type ComponentProps } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  createProjectRpc,
  getProjectRpc,
  submitPlanRpc,
  decideApprovalRpc,
  createJobRpc,
  createUploadRpc, getUploadStatusRpc, writeUploadChunkRpc, commitUploadRpc,
  startPlanningRunRpc, steerPlanningRunRpc, followUpPlanningRunRpc, stopPlanningRunRpc, getEventsRpc,
  analyzeAssetRpc, contactSheetRpc,
  type ApprovalRequest, type BlobRef, type EditorEvent, type PlanningRunStatus, type ProjectSnapshot,
} from "../shared/contracts/v1.js";
import { ReviewPlayer } from "./review-player.js";
import { proposeCut, proposeCutOut, proposeConcat } from "./cut.js";
import { SourceImport } from "./import-source.js";
import { mountSourcePicker, digestSource } from "./web.js";

function DeskControl<T>({
  action,
  value,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "onPress"> & { action: (value: T) => void; value: T }) {
  const press = useCallback(() => action(value), [action, value]);
  return <Pressable {...props} onPress={press} />;
}

const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

export function EditDesk({ theme, layout }: PluginSurfaceProps) {
  const create = useRpc(createProjectRpc);
  const read = useRpc(getProjectRpc);
  const submit = useRpc(submitPlanRpc);
  const decide = useRpc(decideApprovalRpc);
  const runJob = useRpc(createJobRpc);
  const declare = useRpc(createUploadRpc);
  const status = useRpc(getUploadStatusRpc);
  const write = useRpc(writeUploadChunkRpc);
  const commit = useRpc(commitUploadRpc);
  const startRun = useRpc(startPlanningRunRpc);
  const steerRun = useRpc(steerPlanningRunRpc);
  const followUpRun = useRpc(followUpPlanningRunRpc);
  const stopRun = useRpc(stopPlanningRunRpc);
  const readEvents = useRpc(getEventsRpc);
  const analyze = useRpc(analyzeAssetRpc);
  const sheet = useRpc(contactSheetRpc);
  const [sourceImport, setSourceImport] = useState<SourceImport | null>(null);
  const [confirmed, setConfirmed] = useState(0);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [title, setTitle] = useState("");
  const [id, setId] = useState("");
  const [selected, select] = useState("");
  const [openMedia, setOpenMedia] = useState("");
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState("1");
  const [cutStart, setCutStart] = useState("0.5");
  const [cutEnd, setCutEnd] = useState("1.5");
  const [totalSec, setTotalSec] = useState("3");
  const [captionText, setCaptionText] = useState("");
  const [captionStart, setCaptionStart] = useState("0");
  const [captionEnd, setCaptionEnd] = useState("1");
  const [gainMilli, setGainMilli] = useState("");
  const [fadeSec, setFadeSec] = useState("");
  const [fadeKind, setFadeKind] = useState<"crossfade" | "fade">("crossfade");
  const [scaleW, setScaleW] = useState("");
  const [scaleH, setScaleH] = useState("");
  const [rot, setRot] = useState("0");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [planPrompt, setPlanPrompt] = useState("");
  const [run, setRun] = useState<PlanningRunStatus | null>(null);
  const [runEvents, setRunEvents] = useState<EditorEvent[]>([]);
  const afterSeq = useRef("0");
  const locked = useRef(false);
  const pickerParent = useRef<View>(null);
  const projectId = project?.projectId;
  useEffect(() => {
    if (layout.platform !== "web" || busy || !projectId) return;
    return mountSourcePicker(pickerParent.current, (file) => {
      if (locked.current) return;
      setConfirmed(0);
      try {
        const importId = `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        setSourceImport(new SourceImport(projectId, file, importId));
        setError("");
      } catch (e) {
        setSourceImport(null);
        setError(e instanceof Error ? e.message : "无法读取所选视频。");
      }
    });
  }, [projectId, busy, layout.platform]);
  const lastRequest = useRef({ key: "", id: "" });
  function requestId(key: string) {
    if (lastRequest.current.key !== key)
      lastRequest.current = {
        key,
        id: `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      };
    return lastRequest.current.id;
  }
  const perform = useCallback(async (task: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
      lastRequest.current = { key: "", id: "" };
    } catch (e) {
      setError(e instanceof Error ? e.message : "未能读取工作台，请重试。");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }, []);
  function show(snapshot: ProjectSnapshot) {
    setProject(snapshot);
    setId(snapshot.projectId);
    select(
      (prev) =>
        snapshot.assets.find((a) => a.assetId === prev)?.assetId ??
        snapshot.assets.find((a) => a.streams.some((s) => s.kind === "video"))?.assetId ??
        "",
    );
  }
  const colors = theme.colors;
  const styles = useMemo(
    () => ({
      ink: { color: colors.foreground },
      muted: { color: colors.foregroundMuted },
      heading: { color: colors.foreground, fontSize: 20, fontWeight: "600" as const },
      row: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      button: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 6,
        backgroundColor: colors.accent,
      },
      disabledButton: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 6,
        backgroundColor: colors.accent,
        opacity: 0.5,
      },
      actionText: { color: colors.accentForeground },
      field: { gap: 4, flexGrow: 1 },
      input: {
        color: colors.foreground,
        minWidth: 86,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: colors.foregroundMuted,
        borderRadius: 4,
      },
      screen: { flex: 1, backgroundColor: colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
      clip: { gap: 4, padding: 10, borderLeftWidth: 3, borderLeftColor: colors.accent },
      source: { padding: 10, borderLeftWidth: 3, borderLeftColor: colors.foregroundMuted },
      error: { color: colors.statusDanger },
    }),
    [colors, layout.compact],
  );
  const { ink, muted, heading, row } = styles;
  function button(label: string, action: () => Promise<void>, disabled = false) {
    return (
      <DeskControl
        accessibilityRole="button"
        disabled={busy || disabled}
        action={perform}
        value={action}
        style={busy || disabled ? styles.disabledButton : styles.button}
      >
        <Text style={styles.actionText}>{label}</Text>
      </DeskControl>
    );
  }
  async function approveJob(approval: ApprovalRequest, purpose: "preview" | "final" | "export") {
    if (!project || project.projectId !== approval.projectId || project.revision !== approval.baseTimelineRevision || approval.purpose !== purpose)
      throw new Error("审批与当前项目版本不匹配，请刷新项目。");
    const { approvalId, baseTimelineRevision: expectedRevision } = approval;
    const { grant } = await decide({ approvalId, expectedRevision, decision: "approve", requestId: `approve-${approvalId}` });
    if (!grant || grant.purpose !== purpose || grant.subjectHash !== approval.subjectHash ||
      grant.projectId !== approval.projectId || grant.approvalId !== approvalId || grant.baseTimelineRevision !== expectedRevision || grant.planHash !== approval.planHash)
      throw new Error("渲染授权与当前审批不匹配，请刷新项目。");
    await runJob({ projectId: approval.projectId, approvalId, grantId: grant.grantId, expectedRevision, requestId: `${purpose}-${approvalId}` });
    show(await read({ projectId: approval.projectId }));
  }
  function mediaControl(label: string, assetId: string, revision: string, blob?: BlobRef, purpose: "play" | "export" | "manifest" = "play") {
    if (layout.platform !== "web" || !project || !blob) return null;
    const key = `${project.projectId}:${assetId}:${revision}:${blob.sha256}:${purpose}`;
    const opened = openMedia === key;
    let buttonLabel = label;
    if (opened) buttonLabel = purpose === "play" ? "关闭播放器" : "关闭下载";
    return <View key={key}>
      <DeskControl accessibilityRole="button" action={setOpenMedia} value={opened ? "" : key} style={styles.button}>
        <Text style={styles.actionText}>{buttonLabel}</Text>
      </DeskControl>
      {opened && <ReviewPlayer key={key} projectId={project.projectId} assetId={assetId} revision={revision} blob={blob} label={label} theme={theme} purpose={purpose} />}
    </View>;
  }
  function field(label: string, value: string, change: (v: string) => void) {
    return (
      <View style={styles.field}>
        <Text style={muted}>{label}</Text>
        <TextInput
          accessibilityLabel={label}
          editable={!busy}
          value={value}
          onChangeText={change}
          autoCapitalize="none"
          style={styles.input}
        />
      </View>
    );
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={heading}>{project?.title ?? "打开剪辑项目"}</Text>
      <View style={row}>
        {field("项目 ID", id, setId)}
        {button("打开项目", async () => show(await read({ projectId: id.trim() })), !id.trim())}
      </View>
      <View style={row}>
        {field("新项目名称", title, setTitle)}
        {button(
          "创建项目",
          async () => {
            show(
              await create({ title: title.trim(), requestId: requestId(`create:${title.trim()}`) }),
            );
            setTitle("");
          },
          !title.trim(),
        )}
      </View>
      {project && (
        <>
          <View style={row}>
            <Text selectable style={muted}>
              版本 {project.revision} · {project.assets.length} 份素材
            </Text>
            {button("刷新项目", async () => show(await read({ projectId: project.projectId })))}
          </View>
          <Text style={heading}>源素材</Text>
          {layout.platform === "web" && <View style={row}>
            <View>
              <Text style={muted}>选择本机视频</Text>
              <View ref={pickerParent} collapsable={false} />
            </View>
            {sourceImport?.projectId === project.projectId ? <>
              <Text style={muted}>{sourceImport.file.name} · 已确认 {confirmed} / {sourceImport.file.size} 字节</Text>
              {button("导入所选视频", async () => {
                const asset = await sourceImport.transfer({declare, status, write, commit}, digestSource, setConfirmed);
                show(await read({projectId: project.projectId}));
                if (asset.streams.some(stream => stream.kind === "video")) select(asset.assetId);
                setSourceImport(null);
              })}
            </> : <Text style={muted}>单个视频不超过 64 MiB。</Text>}
          </View>}
          {project.assets.length === 0 && (
            <Text style={muted}>项目中还没有素材。导入视频后可设置入点和出点。</Text>
          )}
          {project.assets.map((asset) => (
            <DeskControl
              key={asset.assetId}
              accessibilityRole="button"
              accessibilityState={selected === asset.assetId ? SELECTED : NOT_SELECTED}
              disabled={busy || !asset.streams.some((s) => s.kind === "video")}
              action={select}
              value={asset.assetId}
              style={selected === asset.assetId ? styles.clip : styles.source}
            >
              <Text style={ink}>{asset.displayName}</Text>
              <Text style={muted}>
                {asset.streams.map((s) => s.codec).join(" / ")} · {asset.original.bytes} 字节
              </Text>
              {asset.streams.some((s) => s.kind === "video") &&
                button("分析采样", async () => {
                  await analyze({
                    requestId: requestId(`analyze:${asset.assetId}`),
                    projectId: project.projectId,
                    assetId: asset.assetId,
                  });
                  show(await read({ projectId: project.projectId }));
                })}
              {asset.streams.some((s) => s.kind === "video") &&
                button("生成联系表", async () => {
                  const result = await sheet({
                    requestId: requestId(`sheet:${asset.assetId}`),
                    projectId: project.projectId,
                    assetId: asset.assetId,
                    maxTiles: "12",
                  });
                  setNotice(`联系表 ${result.columns}x${result.rows}（${result.tiles} 格）已生成 · SHA-256 ${result.blob.sha256.slice(0, 12)}`);
                })}
            </DeskControl>
          ))}
          {selected !== "" && (
            <>
              {mediaControl("查看源素材代理（无声）", selected, project.revision, project.assets.find(a => a.assetId === selected)?.proxy)}
              <Text style={heading}>单段裁剪</Text>
              <View style={row}>
                {field("入点（秒，含）", start, setStart)}
                {field("出点（秒，不含）", end, setEnd)}
              </View>
              <View style={row}>
                {field("字幕文本（烧录）", captionText, setCaptionText)}
                {field("字幕起点（秒）", captionStart, setCaptionStart)}
                {field("字幕终点（秒）", captionEnd, setCaptionEnd)}
                {field("音量增益（毫分贝，可空）", gainMilli, setGainMilli)}
                {field("缩放宽（可空）", scaleW, setScaleW)}
                {field("缩放高（可空）", scaleH, setScaleH)}
                {field("旋转（0/90/180/270）", rot, setRot)}
              </View>
              {button("提交裁剪方案", async () => {
                const draft = proposeCut(
                  project,
                  selected,
                  start,
                  end,
                  captionText.trim()
                    ? { text: captionText.trim(), start: captionStart, end: captionEnd }
                    : undefined,
                  gainMilli,
                  scaleW.trim() || scaleH.trim() || rot.trim() !== "0"
                    ? {
                        scaleW,
                        scaleH,
                        rotation: (["0", "90", "180", "270"].includes(rot.trim())
                          ? rot.trim()
                          : "0") as "0" | "90" | "180" | "270",
                      }
                    : undefined,
                );
                const token = requestId(JSON.stringify(draft));
                await submit({
                  requestId: token,
                  runId: `manual-${token}`,
                  toolCallId: token,
                  draft,
                });
                show(await read({ projectId: project.projectId }));
              })}
              <View style={row}>
                {field("删除起点（秒）", cutStart, setCutStart)}
                {field("删除终点（秒）", cutEnd, setCutEnd)}
                {field("素材总长（秒）", totalSec, setTotalSec)}
                {field("转场时长（秒，空则无转场）", fadeSec, setFadeSec)}
                {button(fadeKind === "crossfade" ? "转场类型：叠化" : "转场类型：黑场", () =>
                  setFadeKind(fadeKind === "crossfade" ? "fade" : "crossfade"))}
              </View>
              {button("删除中段并拼接", async () => {
                const draft = proposeCutOut(project, selected, cutStart, cutEnd, totalSec);
                const token = requestId(JSON.stringify(draft));
                await submit({
                  requestId: token,
                  runId: `manual-${token}`,
                  toolCallId: token,
                  draft,
                });
                show(await read({ projectId: project.projectId }));
              })}
              {project.assets.filter((a) => a.streams.some((s) => s.kind === "video")).length > 1 &&
                button("拼接：选中片段 + 首个素材全程", async () => {
                  const first = project.assets.find((a) => a.streams.some((s) => s.kind === "video"))!;
                  const draft = proposeConcat(
                    project,
                    [
                      { assetId: selected, start, end },
                      { assetId: first.assetId, start: "0", end: totalSec },
                    ],
                    fadeSec.trim() || undefined,
                    fadeKind,
                  );
                  const token = requestId(JSON.stringify(draft));
                  await submit({
                    requestId: token,
                    runId: `manual-${token}`,
                    toolCallId: token,
                    draft,
                  });
                  show(await read({ projectId: project.projectId }));
                })}
            </>
          )}
          <Text style={heading}>Agent 规划</Text>
          <View style={row}>
            {field("规划意图（自然语言）", planPrompt, setPlanPrompt)}
          </View>
          <View style={row}>
            {button("开始规划", async () => {
              if (!project) return;
              const started = await startRun({
                requestId: requestId(`plan:${planPrompt}`),
                projectId: project.projectId,
                prompt: planPrompt.trim(),
              });
              setRun(started);
              setRunEvents([]);
              afterSeq.current = "0";
            }, !planPrompt.trim() || !!run && run.state === "running")}
            {button("继续/补充", async () => {
              if (!project || !run || !planPrompt.trim()) return;
              await followUpRun({
                requestId: requestId(`follow:${planPrompt}`),
                projectId: project.projectId,
                runId: run.runId,
                text: planPrompt.trim(),
              });
            }, !run || run.state !== "running" || !planPrompt.trim())}
            {button("停止规划", async () => {
              if (!project || !run) return;
              setRun(await stopRun({ projectId: project.projectId, runId: run.runId }));
            }, !run || run.state !== "running")}
          </View>
          {run && (
            <Text style={muted}>
              run {run.runId} · {run.state}{run.workerPid ? ` · worker pid ${run.workerPid}` : ""}
            </Text>
          )}
          {runEvents.length > 0 && (
            <View style={styles.clip}>
              {runEvents.slice(-12).map((event) => (
                <Text key={event.eventId} style={muted}>
                  {event.seq} · {event.type}
                </Text>
              ))}
            </View>
          )}
          {project && button("刷新事件", async () => {
            const result = await readEvents({ projectId: project.projectId, afterSeq: afterSeq.current });
            const fresh = result.events.filter((e) => e.runId === run?.runId || e.type.startsWith("run."));
            if (result.events.length) afterSeq.current = result.events[result.events.length - 1].seq;
            setRunEvents((prev) => [...prev, ...fresh]);
            if (run) {
              const latest = [...result.events].reverse().find((e) => e.runId === run.runId && e.type.startsWith("run."));
              if (latest) setRun((prev) => prev && { ...prev, state: latest.type.slice(4) as PlanningRunStatus["state"] });
            }
          })}
          <Text style={heading}>已提议的时间线</Text>
          {!project.plans.length && <Text style={muted}>尚无裁剪方案。提交方案不会开始渲染。</Text>}
          {project.plans.map((plan) => (
            <View key={plan.planId} style={styles.clip}>
              <Text style={ink}>{plan.intent}</Text>
              <Text style={muted}>
                {plan.trimOperations.length} 段 · {plan.transitionOperations.length} 转场 · {plan.transformOperations.length} 变换 · {plan.audioOperations.length} 音频 · {plan.subtitleOperations.length} 字幕
              </Text>
              {plan.trimOperations.map((op) => (
                <Text key={op.opId} style={muted}>
                  {op.trackId} · 源入点 {op.sourceRange.start.num}/{op.sourceRange.start.den} 秒 ·
                  保留 {op.sourceRange.duration.num}/{op.sourceRange.duration.den} 秒
                </Text>
              ))}
            </View>
          ))}
          {project.approvals.filter(a=>a.purpose === "preview" && a.status === "pending").map(approval => <View key={approval.approvalId} style={styles.clip}>
            <Text style={heading}>预览审批</Text>
            <Text style={ink}>{approval.diffSummary.intent}</Text>
            <Text selectable style={muted}>项目版本 {approval.baseTimelineRevision} · 方案 {approval.subjectHash}</Text>
            <Text style={muted}>{approval.diffSummary.operationCount} 项编辑 · {approval.diffSummary.summary}</Text>
            <Text style={muted}>只渲染预览，不批准成品或导出。</Text>
            {button("拒绝预览方案", async () => {
              await decide({
                approvalId: approval.approvalId, expectedRevision: approval.baseTimelineRevision,
                decision: "reject", requestId: `reject-${approval.approvalId}`,
              });
              show(await read({projectId: project.projectId}));
            }, approval.baseTimelineRevision !== project.revision)}
            {button("批准并渲染预览", () => approveJob(approval, "preview"), approval.baseTimelineRevision !== project.revision)}
          </View>)}
          {project.approvals.filter(a => a.purpose === "preview" && a.status === "rejected").map(a => (
            <Text key={a.approvalId} style={muted}>已拒绝预览 · {a.diffSummary.intent}</Text>
          ))}
          {project.jobs.map(job => {
            const preview = job.kind === "preview" && job.state === "awaiting_review"
              ? job.artifacts.find(a => a.kind === "candidate" && a.revision === job.candidateRevision)
              : undefined;
            const finalApproval = preview && project.approvals.find(a =>
              a.purpose === "final" && a.subjectType === "candidate_revision" && a.subjectId === job.jobId &&
              a.subjectRevision === preview.revision && a.subjectHash === preview.blob.sha256 && a.planHash === job.planHash &&
              (a.status === "pending" || (a.status === "approved" && !project.jobs.some(j => j.approvalId === a.approvalId))),
            );
            const finalCandidate = job.kind === "final" && job.state === "awaiting_delivery_approval"
              ? job.artifacts.find(a => a.kind === "candidate" && a.revision === job.candidateRevision) : undefined;
            const proxy = finalCandidate && job.artifacts.find(a => a.kind === "proxy" && a.revision === finalCandidate.revision && a.projectId === project.projectId && a.jobId === job.jobId);
            const delivery = proxy && finalCandidate && project.approvals.find(a =>
              a.purpose === "export" && a.subjectId === job.jobId && a.subjectRevision === finalCandidate.revision && a.planHash === job.planHash && a.subjectHash === finalCandidate.blob.sha256 &&
              a.requiredInputs.some(i => i.type === "review_proxy" && i.id === proxy.artifactId && i.hash === proxy.blob.sha256 && i.revision === proxy.revision) &&
              (a.status === "pending" || (a.status === "approved" && !project.jobs.some(j => j.approvalId === a.approvalId))),
            );
            return <View key={job.jobId} style={styles.clip}>
              <Text style={ink}>{job.kind === "preview" ? "预览" : job.kind} · {job.state === "awaiting_review" ? "等待审片" : job.state}</Text>
              {job.kind === "export" && job.state === "completed" && job.artifacts.map(a =>
                a.projectId === project.projectId && a.jobId === job.jobId && (a.kind === "export" || a.kind === "manifest")
                  ? mediaControl(a.kind === "export" ? "准备下载成品视频" : "准备下载导出清单", a.artifactId, a.revision, a.blob, a.kind)
                  : null,
              )}
              {preview && mediaControl("观看预览候选", preview.artifactId, preview.revision, preview.blob)}
              {proxy && delivery && layout.platform === "web" && <View>
                <Text style={heading}>成品交付审批</Text>
                <Text selectable style={muted}>成品版本 {delivery.subjectRevision} · SHA-256 {delivery.subjectHash}</Text>
                {mediaControl("观看成品审片代理", proxy.artifactId, proxy.revision, proxy.blob)}
                <Text style={muted}>审片使用从此成品生成的 640×360 副本。批准后交付原尺寸成品，不重新渲染。</Text>
                {button(delivery.status === "approved" ? "继续已批准的交付" : "确认审片并批准导出", () => approveJob(delivery, "export"), delivery.baseTimelineRevision !== project.revision)}
              </View>}
              {finalApproval && <View>
                <Text selectable style={muted}>预览候选 {finalApproval.subjectRevision} · SHA-256 {finalApproval.subjectHash}</Text>
                <Text style={muted}>按源尺寸渲染成品候选。导出需要单独批准。</Text>
                {button(finalApproval.status === "approved" ? "继续已批准的成品渲染" : "批准渲染成品候选",
                  () => approveJob(finalApproval, "final"), finalApproval.baseTimelineRevision !== project.revision)}
              </View>}
            </View>;
          })}
        </>
      )}
      {busy && (
        <Text accessibilityLiveRegion="polite" style={muted}>
          正在与项目同步…
        </Text>
      )}
      {!!notice && (
        <Text accessibilityLiveRegion="polite" style={muted}>
          {notice}
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </ScrollView>
  );
}
