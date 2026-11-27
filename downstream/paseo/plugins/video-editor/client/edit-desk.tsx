import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, useMemo, useCallback, type ComponentProps } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  getCapabilitiesRpc,
  createProjectRpc,
  getProjectRpc,
  listProjectsRpc,
  submitPlanRpc,
  estimateTimelineRpc,
  decideApprovalRpc, revokeApprovalRpc,
  createJobRpc,
  createUploadRpc, getUploadStatusRpc, writeUploadChunkRpc, commitUploadRpc, cancelUploadRpc, getMutationResultRpc,
  startPlanningRunRpc, followUpPlanningRunRpc, stopPlanningRunRpc, getEventsRpc, getRunEventsRpc, listApprovalsRpc, listPlansRpc, createObjectEditSessionRpc, listObjectEditSessionsRpc, decideCandidateRpc, getRunQuestionsRpc, answerRunQuestionRpc, bindObjectEditPlanRpc, advanceObjectEditSessionRpc, setModelPolicyRpc, getModelPoliciesRpc, removeModelPolicyRpc, refreshObjectEditCandidatesRpc, setProjectCloudPolicyRpc,
  analyzeAssetRpc, getAnalysisRpc, getQaSummaryRpc, getSceneCutsRpc, getWaveformRpc, getPlanRpc, listArtifactsRpc, getExportSummaryRpc, verifyExportRpc, getAssetMetadataRpc, contactSheetRpc, previewFramesRpc, controlJobRpc,
  type ApprovalRequest, type SourceAsset, type BlobRef, type CapabilitySet, type EditorEvent, type PlanningRunStatus, type ProjectSnapshot, type ObjectEditSession, type RunQuestion, type ModelPolicy, type ModelStage,
} from "../shared/contracts/v1.js";
import { FrameInspector } from "./frame-inspector.js";
import { TrackedMaskReview } from "./tracked-mask-review.js";
import { ReviewPlayer } from "./review-player.js";
import { proposeCut, proposeCutOut, proposeConcat, proposeOverlay, findSilentRange } from "./cut.js";
import { SourceImport } from "./import-source.js";
import { mountSourcePicker, digestSource } from "./web.js";
import { planningRunUpdate } from "./planning-events.js";

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

interface SceneCutDoc {
  threshold?: string;
  truncated?: boolean;
  cuts: Array<{ frameIndex: number; ptsTime: string; score: string; aligned: { num: string; den: string } }>;
}

interface WaveformDoc {
  bucketMs?: number;
  truncated?: boolean;
  buckets: string[];
}

export function EditDesk({ theme, layout }: PluginSurfaceProps) {
  const caps = useRpc(getCapabilitiesRpc);
  const create = useRpc(createProjectRpc);
  const read = useRpc(getProjectRpc);
  const list = useRpc(listProjectsRpc);
  const submit = useRpc(submitPlanRpc);
  const estimate = useRpc(estimateTimelineRpc);
  const decide = useRpc(decideApprovalRpc);
  const revoke = useRpc(revokeApprovalRpc);
  const runJob = useRpc(createJobRpc);
  const declare = useRpc(createUploadRpc);
  const status = useRpc(getUploadStatusRpc);
  const write = useRpc(writeUploadChunkRpc);
  const commit = useRpc(commitUploadRpc);
  const lookup = useRpc(getMutationResultRpc);
  const cancelUp = useRpc(cancelUploadRpc);
  const startRun = useRpc(startPlanningRunRpc);
  const followUpRun = useRpc(followUpPlanningRunRpc);
  const stopRun = useRpc(stopPlanningRunRpc);
  const readEvents = useRpc(getEventsRpc);
  const readRunEvents = useRpc(getRunEventsRpc);
  const listApprovals = useRpc(listApprovalsRpc);
  const listPlans = useRpc(listPlansRpc);
  const createOes = useRpc(createObjectEditSessionRpc);
  const listOes = useRpc(listObjectEditSessionsRpc);
  const decideCand = useRpc(decideCandidateRpc);
  const readRunQuestions = useRpc(getRunQuestionsRpc);
  const bindOesPlan = useRpc(bindObjectEditPlanRpc);
  const advanceOes = useRpc(advanceObjectEditSessionRpc);
  const answerQuestion = useRpc(answerRunQuestionRpc);
  const setModelPolicy = useRpc(setModelPolicyRpc);
  const readPolicies = useRpc(getModelPoliciesRpc);
  const removePolicy = useRpc(removeModelPolicyRpc);
  const refreshOes = useRpc(refreshObjectEditCandidatesRpc);
  const setCloudPolicy = useRpc(setProjectCloudPolicyRpc);
  const analyze = useRpc(analyzeAssetRpc);
  const readAnalysis = useRpc(getAnalysisRpc);
  const readQaSummary = useRpc(getQaSummaryRpc);
  const readSceneCuts = useRpc(getSceneCutsRpc);
  const readWaveform = useRpc(getWaveformRpc);
  const readPlan = useRpc(getPlanRpc);
  const listArtifacts = useRpc(listArtifactsRpc);
  const readExportSummary = useRpc(getExportSummaryRpc);
  const verifyExport = useRpc(verifyExportRpc);
  const readAssetMetadata = useRpc(getAssetMetadataRpc);
  const sheet = useRpc(contactSheetRpc);
  const frames = useRpc(previewFramesRpc);
  const controlJob = useRpc(controlJobRpc);
  const [sourceImport, setSourceImport] = useState<SourceImport | null>(null);
  const [activeUpload, setActiveUpload] = useState<AbortController | null>(null);
  const [confirmed, setConfirmed] = useState(0);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [projects, setProjects] = useState<Array<{ projectId: string; title: string; revision: string }>>([]);
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
  const [bgm, setBgm] = useState("");
  const [subMode, setSubMode] = useState<"burn-in" | "metadata">("burn-in");
  const [capsInfo, setCapsInfo] = useState<CapabilitySet | null>(null);
  const [ovX, setOvX] = useState("0");
  const [ovY, setOvY] = useState("0");
  const [fadeIn, setFadeIn] = useState("");
  const [fadeOut, setFadeOut] = useState("");
  const [vFadeIn, setVFadeIn] = useState("");
  const [vFadeOut, setVFadeOut] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [estimateInfo, setEstimateInfo] = useState("");
  const [sheetRef, setSheetRef] = useState<{ projectId: string; assetId: string; artifactId: string; revision: string; blob: BlobRef } | null>(null);
  const [sceneCuts, setSceneCuts] = useState<{ assetId: string; doc: SceneCutDoc } | null>(null);
  const [waveform, setWaveform] = useState<{ assetId: string; doc: WaveformDoc } | null>(null);
  const [mainAsset, setMainAsset] = useState("");
  const [planPrompt, setPlanPrompt] = useState("");
  const [run, setRun] = useState<PlanningRunStatus | null>(null);
  const [runEvents, setRunEvents] = useState<EditorEvent[]>([]);
  const [oes, setOes] = useState<ObjectEditSession | null>(null);
  const [runQuestions, setRunQuestions] = useState<RunQuestion[]>([]);
  const [policies, setPolicies] = useState<ModelPolicy[]>([]);
  const [policyProvider, setPolicyProvider] = useState("local");
  const [policyModel, setPolicyModel] = useState("");
  const [policyStage, setPolicyStage] = useState<ModelStage>("planning");
  const [allowCloud, setAllowCloud] = useState(false);
  const runActive = run?.state === "running" || run?.state === "awaiting_input";
  const afterSeq = useRef("0");
  const runSeq = useRef("0");
  const locked = useRef(false);
  const pickerParent = useRef<View>(null);
  const projectId = project?.projectId;
  useEffect(() => {
    if (capsInfo && !capsInfo.features.includes("burn-in-subtitles"))
      setSubMode((m) => (m === "burn-in" ? "metadata" : m));
  }, [capsInfo]);
  useEffect(() => {
    caps({})
      .then(setCapsInfo)
      .catch(() => setCapsInfo(null));
  }, [caps]);
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
  const perform = useCallback(async (task: () => void | Promise<void>) => {
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
    if (snapshot.projectId !== projectId) {
      setPlanPrompt("");
      setRun(null);
      setRunEvents([]);
      afterSeq.current = "0";
      runSeq.current = "0";
    }
    setProject(snapshot);
    setId(snapshot.projectId);
    select(
      (prev) =>
        snapshot.assets.find((a) => a.assetId === prev)?.assetId ??
        snapshot.assets.find((a) => a.streams.some((s) => s.kind === "video"))?.assetId ??
        "",
    );
  }
  const openProjectId = project?.projectId;
  const refreshMaskApprovals = useCallback(async () => {
    if (!openProjectId) return;
    const snapshot = await read({ projectId: openProjectId });
    setProject(current => current?.projectId === openProjectId ? snapshot : current);
  }, [openProjectId, read]);
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
      timelineRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2, marginTop: 2 },
      trackLabel: { width: 24 },
      seg: { height: 16, borderRadius: 3, backgroundColor: colors.accent, justifyContent: "center" as const, paddingHorizontal: 4 },
      segV2: { height: 16, borderRadius: 3, backgroundColor: colors.foregroundMuted, justifyContent: "center" as const, paddingHorizontal: 4 },
      segText: { color: colors.accentForeground, fontSize: 10 },
      source: { padding: 10, borderLeftWidth: 3, borderLeftColor: colors.foregroundMuted },
      error: { color: colors.statusDanger },
    }),
    [colors, layout.compact],
  );
  const { ink, muted, heading, row } = styles;
  function button(label: string, action: () => void | Promise<void>, disabled = false) {
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
  async function finishImport(projectId: string, asset?: SourceAsset | void) {
    if (asset) {
      show(await read({ projectId }));
      if (asset.streams.some(stream => stream.kind === "video")) select(asset.assetId);
    }
    setNotice(asset ? "素材已导入。" : "已取消未完成的上传。");
    setConfirmed(0);
    setSourceImport(null);
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
  function mediaControl(label: string, assetId: string, revision: string, blob?: BlobRef, purpose: "play" | "export" | "manifest" | "qa" | "contact" = "play") {
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
  function timelineBars(
    ops: Array<{
      opId: string;
      trackId: string;
      clipId: string;
      sourceRange: { start: { num: string; den: string }; duration: { num: string; den: string } };
      recordRange: { start: { num: string; den: string }; duration: { num: string; den: string } };
    }>,
  ) {
    return (
      <>
        {["v1", "v2"].filter((t) => ops.some((o) => o.trackId === t)).map((t) => {
          const trackOps = ops
            .filter((o) => o.trackId === t)
            .sort((a, b) => Number(a.recordRange.start.num) / Number(a.recordRange.start.den) - Number(b.recordRange.start.num) / Number(b.recordRange.start.den));
          return (
            <View key={t} style={styles.timelineRow}>
              <Text style={[styles.muted, styles.trackLabel]}>{t}</Text>
              {trackOps.map((o) => {
                const durMs = (Number(o.recordRange.duration.num) / Number(o.recordRange.duration.den)) * 1000;
                const srcMs = (Number(o.sourceRange.start.num) / Number(o.sourceRange.start.den)) * 1000;
                return (
                  <View key={o.opId} style={[t === "v1" ? styles.seg : styles.segV2, { flexGrow: Math.max(durMs, 1) }]}>
                    <Text style={styles.segText} numberOfLines={1}>{o.clipId} {srcMs / 1000}s</Text>
                  </View>
                );
              })}
            </View>
          );
        })}
      </>
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
      <View style={{ gap: 8 }}>
        <View style={row}>
          <Text style={heading}>我的项目</Text>
          {button("列出可访问项目", async () => setProjects((await list({})).projects))}
        </View>
        {projects.map((entry) => (
          <DeskControl
            key={entry.projectId}
            accessibilityRole="button"
            disabled={busy}
            action={(value: string) => {
              void perform(async () => show(await read({ projectId: value })));
            }}
            value={entry.projectId}
            style={styles.source}
          >
            <Text style={ink}>{entry.title}</Text>
            <Text selectable style={muted}>{entry.projectId} · 版本 {entry.revision}</Text>
          </DeskControl>
        ))}
        {projects.length === 0 && <Text style={muted}>点「列出可访问项目」查看本机或已配对设备可打开的项目。</Text>}
      </View>
      {project && (
        <>
          <View style={row}>
            <Text selectable style={muted}>
              版本 {project.revision} · {project.assets.length} 份素材{project.objectEditSessions.length ? ` · ${project.objectEditSessions.filter((o) => o.state === "awaiting_selection").length} 个待选对象会话` : ""}
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
                const controller = new AbortController();
                setActiveUpload(controller);
                setNotice("");
                try {
                  let asset;
                  try {
                    asset = await sourceImport.transfer({ declare, status, write, commit, cancel: cancelUp }, digestSource, setConfirmed, controller.signal);
                  } catch (error) {
                    if (!controller.signal.aborted) throw error;
                    asset = await sourceImport.cancel({ declare, cancel: cancelUp, lookup });
                  }
                  await finishImport(project.projectId, asset);
                } finally {
                  setActiveUpload(null);
                }
              })}
              {activeUpload ? <DeskControl accessibilityRole="button" style={styles.button}
                value={activeUpload} action={controller => controller.abort()}>
                <Text style={styles.actionText}>取消上传</Text>
              </DeskControl> : button("取消上传", async () => {
                const asset = await sourceImport.cancel({ declare, cancel: cancelUp, lookup });
                await finishImport(project.projectId, asset);
              })}
            </> : <Text style={muted}>单个视频不超过 64 MiB。</Text>}
          </View>}
          {layout.platform !== "web" && (
            <Text style={muted}>源素材导入请在桌面网页端进行（浏览器文件选择）；手机端可浏览素材、设置入出点、提交裁剪方案与审批交付。</Text>
          )}
          {project.assets.length === 0 && (
            <Text style={muted}>项目中还没有素材。导入视频后可设置入点和出点。</Text>
          )}
          {project.assets.map((asset) => (
            <View key={asset.assetId} style={selected === asset.assetId ? styles.clip : styles.source}>
              <DeskControl
                accessibilityRole="button"
                accessibilityState={selected === asset.assetId ? SELECTED : NOT_SELECTED}
                disabled={busy || !asset.streams.some((s) => s.kind === "video")}
                action={select}
                value={asset.assetId}
              >
                <Text style={ink}>{asset.displayName}</Text>
                <Text style={muted}>
                  {asset.streams.map((s) => s.codec).join(" / ")} · {asset.original.bytes} 字节
                </Text>
              </DeskControl>
              {button("元数据", async () => {
                  const meta = await readAssetMetadata({
                    requestId: requestId(`meta:${asset.assetId}`),
                    projectId: project.projectId,
                    assetId: asset.assetId,
                  });
                  const video = meta.streams.find((st) => st.kind === "video");
                  setNotice(`${asset.displayName} · 时长 ${meta.durationSeconds ?? "?"}s · ${meta.frameCount ?? "?"} 帧${video ? ` · ${video.width ?? "?"}x${video.height ?? "?"} @${video.averageRate ? `${video.averageRate.num}/${video.averageRate.den}` : "?"}fps` : ""} · hash ${meta.contentHash.slice(0, 12)}`);
              })}
              {(() => {
                const job = project.jobs
                  .filter((j) => j.analysisAssetId === asset.assetId)
                  .sort((a, b) => (a.jobId < b.jobId ? 1 : -1))[0];
                return job ? (
                  <Text style={muted}>
                    分析 {job.state}
                    {job.artifacts.some((a) => a.kind === "qa") ? " · qa 已生成" : ""}
                  </Text>
                ) : null;
              })()}
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
                  setSheetRef({ ...result, revision: project.revision });
                })}
              {sheetRef && sheetRef.projectId === project.projectId && sheetRef.assetId === asset.assetId && sheetRef.revision === project.revision && mediaControl("查看联系表", sheetRef.artifactId, sheetRef.revision, sheetRef.blob, "contact")}
              {asset.streams.some((s) => s.kind === "video") &&
                button("分析切点/波形", async () => {
                  await analyze({
                    requestId: requestId(`analyze:${asset.assetId}`),
                    projectId: project.projectId,
                    assetId: asset.assetId,
                  });
                  let info: Awaited<ReturnType<typeof readAnalysis>> | null = null;
                  for (let attempt = 0; attempt < 20 && info?.state !== "completed"; attempt++) {
                    const snap = await read({ projectId: project.projectId });
                    show(snap);
                    try {
                      info = await readAnalysis({
                        requestId: requestId(`analysis:${asset.assetId}`),
                        projectId: project.projectId,
                        assetId: asset.assetId,
                      });
                    } catch {
                      info = null;
                    }
                    if (info && (info.state === "failed" || info.state === "cancelled"))
                      throw new Error(`分析失败：${info.error?.sanitizedDetail ?? info.state}`);
                    if (info?.state !== "completed" && attempt < 19)
                      await new Promise((resolve) => setTimeout(resolve, 500));
                  }
                  if (!info || info.state !== "completed") throw new Error("分析尚未完成，请稍后再试。");
                  const cuts = await readSceneCuts({
                    requestId: requestId(`cuts:${asset.assetId}`),
                    projectId: project.projectId,
                    assetId: asset.assetId,
                  });
                  const doc: SceneCutDoc = {
                    threshold: cuts.threshold ?? undefined,
                    truncated: cuts.truncated,
                    cuts: cuts.cuts,
                  };
                  setSceneCuts({ assetId: asset.assetId, doc });
                  let hasWave = false;
                  try {
                    const wave = await readWaveform({
                      requestId: requestId(`wave:${asset.assetId}`),
                      projectId: project.projectId,
                      assetId: asset.assetId,
                    });
                    const wdoc: WaveformDoc = {
                      bucketMs: wave.bucketMs ?? undefined,
                      truncated: wave.truncated,
                      buckets: wave.buckets,
                    };
                    setWaveform({ assetId: asset.assetId, doc: wdoc });
                    hasWave = true;
                  } catch {
                    setWaveform(null);
                  }
                  setNotice(`场景切点 ${doc.cuts.length} 个${doc.truncated ? "（已截断）" : ""} · 阈值 ${doc.threshold ?? "0.3"}${hasWave ? " · 已生成波形" : ""}`);
                })}
              {sceneCuts && sceneCuts.assetId === asset.assetId && (
                <View style={row}>
                  <Text style={muted}>切点（点击设为入点）:</Text>
                  {sceneCuts.doc.cuts.map((c, i) => {
                    const t = String(Math.round(Number(c.aligned.num) / Number(c.aligned.den)) / 1000);
                    return (
                      <View key={`${c.frameIndex}-${i}`} style={row}>
                        <DeskControl
                          accessibilityRole="button"
                          disabled={busy}
                          action={(v: string) => setStart(v)}
                          value={t}
                          style={styles.button}
                        >
                          <Text style={styles.actionText}>{`入 ${c.ptsTime}s · ${c.score}`}</Text>
                        </DeskControl>
                        <DeskControl
                          accessibilityRole="button"
                          disabled={busy}
                          action={(v: string) => setEnd(v)}
                          value={t}
                          style={styles.button}
                        >
                          <Text style={styles.actionText}>{`出 ${c.ptsTime}s · ${c.score}`}</Text>
                        </DeskControl>
                      </View>
                    );
                  })}
                </View>
              )}
              {waveform && waveform.assetId === asset.assetId && (
                <View style={row}>
                  <Text style={muted}>波形:</Text>
                  <Text style={muted}>
                    {waveform.doc.buckets.map((b) => " ▁▂▃▄▅▆▇█"[Math.min(7, Math.max(0, Math.floor(Number(b) * 8)))] ?? " ").join("")}
                  </Text>
                </View>
              )}
            </View>
          ))}
          {selected !== "" && (
            <>
              {mediaControl("查看源素材代理（无声）", selected, project.revision, project.assets.find(a => a.assetId === selected)?.proxy)}
              {project.assets.filter(a => a.assetId === selected && a.streams.some(s => s.kind === "video")).map(asset =>
                <FrameInspector key={project.projectId + asset.assetId} project={project} refresh={refreshMaskApprovals} asset={asset} theme={theme} />)}
              <Text style={heading}>单段裁剪</Text>
              <View style={row}>
                {field("入点（秒，含）", start, setStart)}
                {field("出点（秒，不含）", end, setEnd)}
              </View>
              <View style={row}>
                {field("字幕文本", captionText, setCaptionText)}
                {button(subMode === "burn-in" ? "字幕模式：烧录" : "字幕模式：软字幕", () =>
                  setSubMode(subMode === "burn-in" ? "metadata" : "burn-in"))}
                {capsInfo && !capsInfo.features.includes("burn-in-subtitles") && subMode === "burn-in" && (
                  <Text style={styles.error}>当前主机无 fontconfig，烧录字幕不可用；点击上方按钮切到软字幕</Text>
                )}
                {field("字幕起点（秒）", captionStart, setCaptionStart)}
                {field("字幕终点（秒）", captionEnd, setCaptionEnd)}
                {field("音量增益（毫分贝，可空）", gainMilli, setGainMilli)}
                {field("音频淡入（秒，可空）", fadeIn, setFadeIn)}
                {field("音频淡出（秒，可空）", fadeOut, setFadeOut)}
                {field("视频淡入（秒，可空）", vFadeIn, setVFadeIn)}
                {field("视频淡出（秒，可空）", vFadeOut, setVFadeOut)}
                {field("缩放宽（可空）", scaleW, setScaleW)}
                {field("缩放高（可空）", scaleH, setScaleH)}
                {field("旋转（0/90/180/270）", rot, setRot)}
                {button(bgm ? `BGM：${bgm}` : "BGM：无", () => {
                  const withAudio = project
                    ? project.assets.filter((a) => a.streams.some((s) => s.kind === "audio")).map((a) => a.assetId)
                    : [];
                  const options = ["", ...withAudio];
                  const next = options[(options.indexOf(bgm) + 1) % options.length]!;
                  setBgm(next);
                })}
              </View>
              {(() => {
                try {
                  const draft = proposeCut(project, selected, start, end);
                  return (
                    <View style={row}>
                      <Text style={muted}>草稿时间线:</Text>
                      {timelineBars(draft.trimOperations)}
                    </View>
                  );
                } catch {
                  return null;
                }
              })()}
              {(() => {
                const buildCutDraft = () =>
                  proposeCut(
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
                    bgm || undefined,
                    subMode,
                    fadeIn.trim() || fadeOut.trim()
                      ? { inSec: fadeIn, outSec: fadeOut }
                      : undefined,
                    vFadeIn.trim() || vFadeOut.trim()
                      ? { inSec: vFadeIn, outSec: vFadeOut }
                      : undefined,
                  );
                return (
                  <>
                    {button("预估输出时长", async () => {
                      const draft = buildCutDraft();
                      const est = await estimate({
                        requestId: requestId(`est:${JSON.stringify(draft)}`),
                        draft,
                      });
                      const warnings = est.warnings ?? [];
                      const warn = warnings.length ? ` · 警告：${warnings[0]}${warnings.length > 1 ? ` 等 ${warnings.length} 条` : ""}` : "";
                      setEstimateInfo(
                        est.valid
                          ? `预估输出 ${est.effectiveMainDurationSeconds}s（主轨 ${est.mainDurationSeconds}s · ${est.mainTrackSegments} 段 · 转场重叠 ${est.transitionOverlapSeconds}s · 音频 ${est.audioOperationCount} · 字幕 ${est.subtitleCueCount}）${warn}`
                          : `方案有问题：${est.issue ?? "未知错误"}${warn}`,
                      );
                    })}
                    {button("提交裁剪方案", async () => {
                      const draft = buildCutDraft();
                      const token = requestId(JSON.stringify(draft));
                      await submit({
                        requestId: token,
                        runId: `manual-${token}`,
                        toolCallId: token,
                        draft,
                      });
                      setEstimateInfo("");
                      show(await read({ projectId: project.projectId }));
                    })}
                  </>
                );
              })()}
              {estimateInfo ? <Text style={styles.ink}>{estimateInfo}</Text> : null}
              <View style={row}>
                {field("删除起点（秒）", cutStart, setCutStart)}
                {field("删除终点（秒）", cutEnd, setCutEnd)}
                {field("素材总长（秒）", totalSec, setTotalSec)}
                {field("转场时长（秒，空则无转场）", fadeSec, setFadeSec)}
                {field("叠加X", ovX, setOvX)}
                {field("叠加Y", ovY, setOvY)}
                {button(fadeKind === "crossfade" ? "转场类型：叠化" : "转场类型：黑场", () =>
                  setFadeKind(fadeKind === "crossfade" ? "fade" : "crossfade"))}
              </View>
              {button("静音挖洞", async () => {
                if (!waveform || waveform.assetId !== selected) throw new Error("请先对当前素材运行「分析切点/波形」。");
                const range = findSilentRange(waveform.doc, cutStart, cutEnd);
                if (!range) throw new Error("所选区间内没有连续至少 0.5 秒、RMS 不高于 −40 dBFS 的静音段。");
                const draft = proposeCutOut(project, selected, range.start, range.end, totalSec);
                const token = requestId(JSON.stringify(draft));
                await submit({
                  requestId: token,
                  runId: `manual-${token}`,
                  toolCallId: token,
                  draft,
                });
                setNotice(`已按静音区间 ${range.start}s–${range.end}s 生成挖洞方案，等待审批。`);
                show(await read({ projectId: project.projectId }));
              })}
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
              {project && project.assets.some((a) => a.streams.some((s) => s.kind === "video")) &&
                button(mainAsset && project.assets.some((a) => a.assetId === mainAsset) ? `主素材：${mainAsset}` : "主素材：首个视频素材", () => {
                  const vids = project.assets.filter((a) => a.streams.some((s) => s.kind === "video")).map((a) => a.assetId);
                  const cur = vids.includes(mainAsset) ? mainAsset : vids[0]!;
                  setMainAsset(vids[(vids.indexOf(cur) + 1) % vids.length]!);
                })}
              {project.assets.filter((a) => a.streams.some((s) => s.kind === "video")).length > 1 &&
                button("拼接：选中片段 + 首个素材全程", async () => {
                  const first = project.assets.find((a) => a.assetId === mainAsset) ?? project.assets.find((a) => a.streams.some((s) => s.kind === "video"))!;
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
              {project.assets.filter((a) => a.streams.some((s) => s.kind === "video")).length > 1 &&
                button("画中画：选中片段叠加到首素材全程", async () => {
                  const first = project.assets.find((a) => a.assetId === mainAsset) ?? project.assets.find((a) => a.streams.some((s) => s.kind === "video"))!;
                  const draft = proposeOverlay(project, first.assetId, "0", totalSec, selected, start, end, ovX.trim() || "0", ovY.trim() || "0");
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
              afterSeq.current = project.latestSeq;
              runSeq.current = project.latestSeq;
            }, !planPrompt.trim() || runActive)}
            {button("继续/补充", async () => {
              if (!project || !run || !planPrompt.trim()) return;
              await followUpRun({
                requestId: requestId(`follow:${planPrompt}`),
                projectId: project.projectId,
                runId: run.runId,
                text: planPrompt.trim(),
              });
            }, !runActive || !planPrompt.trim())}
            {button("停止规划", async () => {
              if (!project || !run) return;
              setRun(await stopRun({ projectId: project.projectId, runId: run.runId }));
            }, !runActive)}
          </View>
          {run && (
            <Text style={muted}>
              run {run.runId} · {run.state}{run.workerPid ? ` · worker pid ${run.workerPid}` : ""}
            </Text>
          )}
          {runEvents.length > 0 && (
            <View style={styles.clip}>
              {runEvents.map((event) => (
                <Text key={event.eventId} style={muted}>
                  {event.seq} · {event.type}
                  {event.payload && typeof event.payload === "object" && "tool" in event.payload
                    ? ` · ${String((event.payload as { tool: unknown }).tool)}`
                    : ""}
                </Text>
              ))}
            </View>
          )}
          {project && run && button("规划提问", async () => {
            const r = await readRunQuestions({ requestId: requestId(`questions:${run.runId}`), projectId: project.projectId, runId: run.runId });
            setRunQuestions(r.questions.slice().reverse());
            setNotice(r.questionCount ? `run 有 ${r.questionCount} 条待回答问题` : "当前没有待回答问题");
          })}
          {runQuestions.length > 0 && (
            <View style={styles.clip}>
              {runQuestions.map((q) => (
                <View key={q.eventId}>
                  <Text style={muted}>
                    {q.seq} · {q.text}{q.choices.length ? ` [${q.choices.join("/")}]` : ""}
                  </Text>
                  {project && run && q.choices.map((c) => (
                    <Text key={c}>
                      {button(`回答：${c}`, async () => {
                        await answerQuestion({
                          requestId: requestId(`ans:${run.runId}:${q.questionId}:${c}`),
                          projectId: project.projectId,
                          runId: run.runId,
                          questionId: q.questionId,
                          answer: c,
                        });
                        const r = await readRunQuestions({ requestId: requestId(`questions:${run.runId}:after`), projectId: project.projectId, runId: run.runId });
                        setRunQuestions(r.questions.slice().reverse());
                        setNotice(`已回答「${q.text.slice(0, 20)}」→ ${c}`);
                      })}
                    </Text>
                  ))}
                  {project && run && !q.choices.length && button("回答：确认", async () => {
                    await answerQuestion({
                      requestId: requestId(`ans:${run.runId}:${q.questionId}:ok`),
                      projectId: project.projectId,
                      runId: run.runId,
                      questionId: q.questionId,
                      answer: "确认",
                    });
                    setNotice(`已确认「${q.text.slice(0, 20)}」`);
                  })}
                </View>
              ))}
            </View>
          )}
          {project && button("刷新事件", async () => {
            const result = await readEvents({ projectId: project.projectId, afterSeq: afterSeq.current });
            const snapshot = await read({ projectId: project.projectId });
            show(snapshot);
            afterSeq.current = result.events.at(-1)?.seq ?? afterSeq.current;
            const update = run && planningRunUpdate(run, result.events);
            if (update) setRun(update.run);
            const recent = update?.events ?? result.events.filter((event) => event.type.startsWith("run."));
            setRunEvents((prev) => [...prev, ...recent].slice(-12));
          })}
          {project && run && button("run 事件", async () => {
            const result = await readRunEvents({ requestId: requestId(`run-events:${run.runId}:${runSeq.current}`), projectId: project.projectId, runId: run.runId, afterSeq: runSeq.current });
            runSeq.current = result.events.at(-1)?.seq ?? runSeq.current;
            setRunEvents((prev) => [...prev, ...result.events].slice(-12));
          })}
          <Text style={heading}>模型网关策略</Text>
          {project && <View style={row}>
            {field("provider", policyProvider, setPolicyProvider)}
            {field("modelId", policyModel, setPolicyModel)}
          </View>}
          {project && button("登记策略（planning）", async () => {
            if (!policyModel.trim()) throw new Error("请填写 modelId。");
            const r = await setModelPolicy({
              requestId: requestId(`policy:${policyProvider}:${policyModel}`),
              projectId: project.projectId,
              policy: { provider: policyProvider.trim(), modelId: policyModel.trim(), stages: [policyStage], location: "local", enabled: true, note: "planning stage policy" },
            });
            setNotice(`策略已登记 ${r.provider}/${r.modelId} stages=${r.stages.join(",")}`);
            const l = await readPolicies({ requestId: requestId("policies"), projectId: project.projectId });
            setPolicies(l.policies);
          }, !policyModel.trim())}
          {project && button("刷新策略", async () => {
            const l = await readPolicies({ requestId: requestId("policies"), projectId: project.projectId });
            setPolicies(l.policies);
            setAllowCloud(l.allowCloudModels);
            setNotice(`模型策略 ${l.policyCount} 条 · 云端模型 ${l.allowCloudModels ? "已授权" : "未授权"}`);
          })}
          {project && button(allowCloud ? "关闭云端模型授权" : "开启云端模型授权", async () => {
            const r = await setCloudPolicy({ requestId: requestId(`cloud:${!allowCloud}`), projectId: project.projectId, allowCloudModels: !allowCloud });
            setAllowCloud(r.allowCloudModels);
            setNotice(`云端模型授权已${r.allowCloudModels ? "开启" : "关闭"}`);
          })}
          {policies.map((p) => (
            <View key={`${p.provider}/${p.modelId}`} style={styles.timelineRow}>
              <Text style={muted}>
                {p.provider}/{p.modelId} · {p.stages.join(",")} · {p.location}{p.enabled ? "" : "（已停用）"}
              </Text>
              {project && button("移除", async () => {
                await removePolicy({ requestId: requestId(`rm:${p.provider}:${p.modelId}`), projectId: project.projectId, provider: p.provider, modelId: p.modelId });
                setPolicies((prev) => prev.filter((q) => !(q.provider === p.provider && q.modelId === p.modelId)));
              })}
            </View>
          ))}
          <Text style={heading}>对象编辑（Copilot 闭环）</Text>
          {project && button("创建对象会话", async () => {
            const assetId = selected || project.assets.find((a) => a.streams.some((st) => st.kind === "video"))?.assetId;
            if (!assetId) throw new Error("请先选择一个视频素材。");
            const r = await createOes({ requestId: requestId(`oes:${assetId}`), projectId: project.projectId, assetId });
            setOes(r);
            setNotice(`对象会话 ${r.sessionId.slice(0, 12)} · ${r.candidates.length} 个候选 · 状态 ${r.state} · 绑定版本 ${r.boundRevision}`);
          }, !selected)}
          {project && button("会话列表", async () => {
            const r = await listOes({ requestId: requestId("oes-list"), projectId: project.projectId });
            if (r.sessions.length) setOes(r.sessions[0]);
            setNotice(`对象会话 ${r.sessionCount} 条${r.sessions.length ? ` · 最新 ${r.sessions[0].sessionId.slice(0, 12)} ${r.sessions[0].state}` : ""}`);
          })}
          {oes && oes.projectId === project?.projectId && (
            <View style={styles.clip}>
              <View style={row}>
                <Text style={ink}>会话 {oes.sessionId.slice(0, 12)} · {oes.state} · 版本 {oes.boundRevision}{oes.boundRevision !== project?.revision ? "（已过期，需重建）" : ""}</Text>
                {button("刷新候选", async () => {
                  const r = await refreshOes({ requestId: requestId(`refresh:${oes.sessionId}`), projectId: project!.projectId, sessionId: oes.sessionId });
                  setOes(r);
                  setNotice(`候选 ${r.candidates.length} 个 · 状态 ${r.state}`);
                })}
              </View>
              {oes.candidates.map((c) => {
                const dec = oes.decisions.find((d) => d.candidateId === c.candidateId)?.decision;
                return (
                  <View key={c.candidateId} style={styles.timelineRow}>
                    <Text style={muted}>
                      {c.label} · {c.role} · 置信 {c.confidence} · 风险 {c.riskScore}{dec ? ` · 已选 ${dec}` : ""}
                    </Text>
                    {c.riskReasons.map((r) => <Text key={r} style={styles.error}>风险：{r}</Text>)}
                    {oes.state === "awaiting_selection" && ["remove", "keep", "skip"].map((d) => (
                      <Text key={d}>
                        {button(d === "remove" ? "移除" : d === "keep" ? "保留" : "暂不处理", async () => {
                          const r = await decideCand({
                            requestId: requestId(`dec:${oes.sessionId}:${c.candidateId}:${d}`),
                            projectId: project!.projectId,
                            sessionId: oes.sessionId,
                            candidateId: c.candidateId,
                            decision: d as "remove" | "keep" | "skip",
                          });
                          setOes(r);
                          setNotice(`候选 ${c.candidateId} → ${d} · 会话 ${r.state}`);
                        }, !!dec)}
                      </Text>
                    ))}
                  </View>
                );
              })}
              {oes.state === "mask_review" && <Text style={muted}>已完成候选决策；可在下方任务的审片中通过 objectEditSessionId 关联本会话</Text>}
              {oes.planId && <Text style={muted}>已绑定方案 {oes.planId.slice(0, 12)}{oes.jobId ? ` · 任务 ${oes.jobId.slice(0, 12)}` : ""}</Text>}
              {!oes.planId && oes.state === "mask_review" && project && project.plans.length > 0 && button("绑定最新方案", async () => {
                const plan = project.plans.at(-1)!;
                const r = await bindOesPlan({ requestId: requestId(`bind:${oes.sessionId}:${plan.planId}`), projectId: project.projectId, sessionId: oes.sessionId, planId: plan.planId });
                setOes(r);
                setNotice(`会话绑定方案 ${plan.planId.slice(0, 12)}`);
              })}
              {oes.planId && (oes.state === "mask_review" || oes.state === "preview") && project && (() => {
                const plan = project.plans.find((pl) => pl.planId === oes.planId);
                const jobs = project.jobs.filter((j) => plan && j.planHash === plan.planHash);
                const previewJob = jobs.find((j) => j.kind === "preview");
                const exportJob = jobs.find((j) => j.kind === "export" && j.state === "completed");
                return <View>
                  {oes.state === "mask_review" && previewJob && button("推进到 preview", async () => {
                    const r = await advanceOes({ requestId: requestId(`adv:${oes.sessionId}:preview`), projectId: project.projectId, sessionId: oes.sessionId, target: "preview", jobId: previewJob.jobId });
                    setOes(r); setNotice(`会话 → ${r.state}（任务 ${previewJob.jobId.slice(0, 12)}）`);
                  })}
                  {oes.state === "preview" && exportJob && button("推进到 delivered", async () => {
                    const r = await advanceOes({ requestId: requestId(`adv:${oes.sessionId}:delivered`), projectId: project.projectId, sessionId: oes.sessionId, target: "delivered", jobId: exportJob.jobId });
                    setOes(r); setNotice(`会话 → ${r.state}（导出 ${exportJob.jobId.slice(0, 12)}）`);
                  })}
                  {oes.state !== "delivered" && button("取消会话", async () => {
                    const r = await advanceOes({ requestId: requestId(`adv:${oes.sessionId}:cancel`), projectId: project.projectId, sessionId: oes.sessionId, target: "cancelled" });
                    setOes(r); setNotice(`会话已取消`);
                  })}
                </View>;
              })()}
            </View>
          )}
          <Text style={heading}>已提议的时间线</Text>
          {button("方案列表", async () => {
            const r = await listPlans({ requestId: requestId("plans"), projectId: project.projectId });
            setNotice(`方案 ${r.planCount} 条${r.hasMore ? "（还有更多，游标分页）" : ""} · 最新 ${r.plans.at(-1)?.planId.slice(0, 12) ?? "-"} · ${r.plans.at(-1)?.intent.slice(0, 40) ?? ""}`);
          })}
          {!project.plans.length && <Text style={muted}>尚无裁剪方案。提交方案不会开始渲染。</Text>}
          {project.plans.map((plan) => (
            <View key={plan.planId} style={styles.clip}>
              <Text style={ink}>{plan.intent}</Text>
              <Text style={muted}>
                {plan.trimOperations.length} 段 · {plan.transitionOperations.length} 转场 · {plan.transformOperations.length} 变换 · {plan.audioOperations.length} 音频 · {plan.subtitleOperations.length} 字幕
              </Text>
              {["v1", "v2"].filter((t) => plan.trimOperations.some((o) => o.trackId === t)).map((t) => {
                const trackOps = plan.trimOperations
                  .filter((o) => o.trackId === t)
                  .sort((a, b) => Number(a.recordRange.start.num) / Number(a.recordRange.start.den) - Number(b.recordRange.start.num) / Number(b.recordRange.start.den));
                return (
                  <View key={t} style={styles.timelineRow}>
                    <Text style={[styles.muted, styles.trackLabel]}>{t}</Text>
                    {trackOps.map((o) => {
                      const durMs = (Number(o.recordRange.duration.num) / Number(o.recordRange.duration.den)) * 1000;
                      const srcMs = (Number(o.sourceRange.start.num) / Number(o.sourceRange.start.den)) * 1000;
                      return (
                        <View key={o.opId} style={[t === "v1" ? styles.seg : styles.segV2, { flexGrow: Math.max(durMs, 1) }]}>
                          <Text style={styles.segText} numberOfLines={1}>{o.clipId} {srcMs / 1000}s</Text>
                        </View>
                      );
                    })}
                  </View>
                );
              })}
              {button("预估时长", async () => {
                const est = await estimate({
                  requestId: requestId(`est-plan:${plan.planId}`),
                  projectId: project.projectId,
                  planId: plan.planId,
                });
                const warn = est.warnings?.length ? ` · 警告 ${est.warnings.slice(0, 3).join("；")}` : "";
                setNotice(`方案 ${plan.planId.slice(0, 12)} · 主轨 ${est.mainDurationSeconds}s（扣转场 ${est.effectiveMainDurationSeconds}s）· 叠加 ${est.overlayDurationSeconds}s · 转场 ${est.transitionCount} · 音频 ${est.audioOperationCount} · 字幕 ${est.subtitleCueCount}${est.valid ? "" : ` · 方案问题：${est.issue ?? "未知错误"}`}${warn}`);
              })}
              {plan.transitionOperations.map((tr) => (
                <Text key={tr.opId} style={muted}>
                  转场 {tr.kind} {tr.leftClipId}→{tr.rightClipId} {tr.duration.num}/{tr.duration.den}s
                </Text>
              ))}
              {plan.transformOperations.map((tr) => (
                <Text key={tr.opId} style={muted}>
                  变换 {tr.clipId} scale={tr.scale.width}x{tr.scale.height} rot={tr.rotationDegrees}
                </Text>
              ))}
              {plan.generationRequests.map(g=><Text key={g.requestId} selectable style={muted}>
                VACE 1.3B · 9 帧 · 832×480 · 20 步 · 种子 {g.seed} · {g.prompt}{g.negativePrompt ? " · 负面提示："+g.negativePrompt : ""}
              </Text>)}
              {plan.audioOperations.map((a) => (
                <Text key={a.opId} style={muted}>
                  音频 {a.clipId} gain={a.gainMilli}mB{a.mute ? " 静音" : ""}
                  {a.fadeIn || a.fadeOut ? ` fade=${a.fadeIn?.num ?? "0"}/${a.fadeOut?.num ?? "0"}ms` : ""}
                </Text>
              ))}
              {plan.trimOperations.map((op) => (
                <Text key={op.opId} style={muted}>
                  {op.trackId} · 源入点 {op.sourceRange.start.num}/{op.sourceRange.start.den} 秒 ·
                  保留 {op.sourceRange.duration.num}/{op.sourceRange.duration.den} 秒
                  {op.overlayX !== undefined ? ` · 叠加@${op.overlayX},${op.overlayY}` : ""}
                </Text>
              ))}
            </View>
          ))}
          {project.approvals.filter(a=>a.purpose === "preview" && a.status === "pending").map(approval => <View key={approval.approvalId} style={styles.clip}>
            <Text style={heading}>预览审批</Text>
            {button("待审批", async () => {
              const r = await listApprovals({ requestId: requestId("approvals:pending"), projectId: project.projectId, status: "pending" });
              setNotice(`待审批 ${r.approvalCount} 条${r.approvals.length ? ` · 最新 ${r.approvals.at(-1)?.subjectType}/${r.approvals.at(-1)?.purpose}` : ""}`);
            })}
            <Text style={ink}>{approval.diffSummary.intent}</Text>
            <Text selectable style={muted}>项目版本 {approval.baseTimelineRevision} · 方案 {approval.subjectHash}{approval.objectEditSessionId ? ` · 对象会话 ${approval.objectEditSessionId.slice(0, 12)}` : ""}</Text>
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
            {button("撤销审批", async () => {
              await revoke({
                requestId: requestId(`revoke:${approval.approvalId}`),
                projectId: project.projectId,
                approvalId: approval.approvalId,
              });
              show(await read({ projectId: project.projectId }));
            })}
          </View>)}
          {project.approvals.filter(a => a.purpose === "preview" && a.status === "rejected").map(a => (
            <Text key={a.approvalId} style={muted}>已拒绝预览 · {a.diffSummary.intent}</Text>
          ))}
          {project.approvals.filter(a => a.status === "revoked").map(a => (
            <Text key={a.approvalId} style={muted}>已撤销 · {a.diffSummary.intent}</Text>
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
              {(job.phaseDetail || job.progress) && (
                <Text style={muted}>
                  {job.phaseDetail ?? ""}{job.progress ? ` · ${job.progress.completedUnits}${job.progress.totalUnits ? `/${job.progress.totalUnits}` : ""} 单元` : ""}
                </Text>
              )}
              {["draft", "analyzing", "awaiting_inputs", "rendering_preview", "rendering_final", "validating", "pausing", "paused", "awaiting_plan_approval"].includes(job.state) &&
                button("取消任务", async () => {
                  await controlJob({ requestId: requestId(`cancel:${job.jobId}`), projectId: project.projectId, jobId: job.jobId, action: "cancel" });
                  show(await read({ projectId: project.projectId }));
                })}
              {["analyzing", "rendering_preview", "rendering_final", "validating", "awaiting_inputs"].includes(job.state) &&
                button("暂停任务", async () => {
                  await controlJob({ requestId: requestId(`pause:${job.jobId}`), projectId: project.projectId, jobId: job.jobId, action: "pause" });
                  show(await read({ projectId: project.projectId }));
                })}
              {job.state === "paused" &&
                button("继续任务", async () => {
                  await controlJob({ requestId: requestId(`resume:${job.jobId}`), projectId: project.projectId, jobId: job.jobId, action: "resume" });
                  show(await read({ projectId: project.projectId }));
                })}
              {button("产物", async () => {
                const arts = await listArtifacts({
                  requestId: requestId(`arts:${job.jobId}`),
                  projectId: project.projectId,
                  jobId: job.jobId,
                });
                const summary = arts.artifacts.slice(0, 8).map((a) => `${a.kind} ${a.sizeBytes}B ${a.sha256.slice(0, 8)}`).join(", ");
                setNotice(`任务 ${job.jobId.slice(0, 12)} · ${arts.artifactCount} 个产物${summary ? ` · ${summary}${arts.artifactCount > 8 ? " …" : ""}` : ""}`);
              })}
              {button("方案", async () => {
                const plan = project.plans.find((p) => p.planHash === job.planHash);
                if (!plan) throw new Error("找不到该任务对应的方案。");
                const full = await readPlan({
                  requestId: requestId(`plan:${plan.planId}`),
                  projectId: project.projectId,
                  planId: plan.planId,
                });
                setNotice(`方案 ${full.planId.slice(0, 12)} · 裁剪 ${full.trimOperations.length} · 转场 ${full.transitionOperations.length} · 音频 ${full.audioOperations.length} · 字幕 ${full.subtitleOperations.length} · 变换 ${full.transformOperations.length} · hash ${String(full.planHash).slice(0, 12)}`);
              })}
              {(job.state === "failed" || job.state === "cancelled") &&
                button("重试任务", async () => {
                  await controlJob({ requestId: requestId(`retry:${job.jobId}`), projectId: project.projectId, jobId: job.jobId, action: "retry" });
                  show(await read({ projectId: project.projectId }));
                })}
              {job.state === "failed" && job.error && (
                <Text style={styles.error}>{job.error.code} · {job.error.sanitizedDetail}</Text>
              )}
              {job.kind === "export" && job.state === "completed" && button("导出摘要", async () => {
                const ex = await readExportSummary({
                  requestId: requestId(`export:${job.jobId}`),
                  projectId: project.projectId,
                  jobId: job.jobId,
                });
                setNotice(`导出 ${ex.exportId ?? job.jobId.slice(0, 12)} · 段 ${ex.segmentCount} · 转场 ${ex.transitionCount} · 音频 ${ex.audioOperationCount} · 字幕 ${ex.subtitleCueCount} · recipe ${ex.renderRecipeHash?.slice(0, 12) ?? "-"} · plan ${ex.planHash?.slice(0, 12) ?? "-"} · 输出 ${ex.output ? `${ex.output.bytes}B ${ex.output.sha256.slice(0, 12)}` : "-"}`);
              })}
              {job.kind === "export" && job.state === "completed" && button("校验导出", async () => {
                const v = await verifyExport({
                  requestId: requestId(`verify:${job.jobId}`),
                  projectId: project.projectId,
                  jobId: job.jobId,
                });
                setNotice(v.verified
                  ? `导出校验通过：输出 SHA-256 ${v.outputSha256?.slice(0, 12)} 与 manifest 一致（recipe ${v.renderRecipeHash?.slice(0, 12) ?? "-"}）`
                  : `导出校验失败：${v.detail}`);
              })}
              {job.kind === "export" && job.state === "completed" && job.artifacts.map(a =>
                a.projectId === project.projectId && a.jobId === job.jobId && (a.kind === "export" || a.kind === "manifest")
                  ? mediaControl(a.kind === "export" ? "准备下载成品视频" : "准备下载导出清单", a.artifactId, a.revision, a.blob, a.kind)
                  : null,
              )}
              {layout.platform === "web" && job.kind === "analysis" && job.state === "completed" &&
                <TrackedMaskReview project={project} job={job} refresh={refreshMaskApprovals} theme={theme} />}
              {preview && mediaControl("观看预览候选", preview.artifactId, preview.revision, preview.blob)}
              {preview && button("预览帧", async () => {
                const result = await frames({
                  requestId: requestId(`frames:${job.jobId}`),
                  projectId: project.projectId,
                  jobId: job.jobId,
                  maxTiles: "12",
                });
                setNotice(`预览帧 ${result.columns}x${result.rows}（${result.tiles} 格）已生成 · SHA-256 ${result.blob.sha256.slice(0, 12)}`);
                setSheetRef({ ...result, revision: preview.revision });
              })}
              {preview && sheetRef?.projectId === project.projectId && sheetRef.assetId === preview.artifactId && sheetRef.revision === preview.revision && mediaControl("查看预览帧", sheetRef.artifactId, sheetRef.revision, sheetRef.blob, "contact")}
              {job.artifacts
                .filter((a) => a.kind === "qa")
                .map((a) => mediaControl("查看 QA 报告", a.artifactId, a.revision, a.blob, "qa"))}
              {job.artifacts.some((a) => a.kind === "qa") && button("QA 摘要", async () => {
                const q = await readQaSummary({
                  requestId: requestId(`qa:${job.jobId}`),
                  projectId: project.projectId,
                  jobId: job.jobId,
                });
                const gates = q.gates.map((g) => `${g.gate}=${g.status}`).join(",") || "无门禁";
                const loud = q.audioLoudness ? ` · 响度 ${q.audioLoudness.meanVolumeDb}/${q.audioLoudness.maxVolumeDb} dB` : "";
                setNotice(`QA ${q.state} · ${q.durationSeconds ?? "?"}s · ${q.streams.map((st) => st.codecName ?? st.codecType).join("/") || "无流"}${loud} · recipe ${q.renderRecipeHash?.slice(0, 12) ?? "-"} · ${gates}`);
              })}
              {proxy && delivery && <View>
                <Text style={heading}>成品交付审批</Text>
                <Text selectable style={muted}>成品版本 {delivery.subjectRevision} · SHA-256 {delivery.subjectHash}</Text>
                {mediaControl("观看成品审片代理", proxy.artifactId, proxy.revision, proxy.blob)}
                {layout.platform !== "web" && <Text style={muted}>审片代理的播放请在桌面网页端进行；此处可核对版本与哈希并批准交付。</Text>}
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
