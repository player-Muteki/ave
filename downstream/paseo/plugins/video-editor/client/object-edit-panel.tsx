import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  decideObjectTargetRpc,
  getAssetMetadataRpc,
  getObjectEditRpc,
  listObjectEditsRpc,
  openObjectEditRpc,
  reviewObjectMaskRpc,
  type ObjectDecision,
  type ObjectEditWorkflow,
  type ProjectSnapshot,
  type SourceAsset,
} from "../shared/contracts/v1.js";
import {
  ROLE_LABELS,
  describeObjectEditState,
  decisionsById,
  rankCandidates,
  riskBand,
} from "./object-edit-view.js";

const RISK_LABELS = { low: "低风险", medium: "中风险", high: "高风险" } as const;
const actionStyle = { padding: 8 };
const disabledStyle = { padding: 8, opacity: 0.5 };

function newRequestId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rangeFromSeconds(seconds: number): { start: { num: string; den: string }; duration: { num: string; den: string } } | undefined {
  if (!(seconds > 0)) return undefined;
  let num = Math.round(seconds * 1000);
  let den = 1000;
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(num, den);
  num /= divisor;
  den /= divisor;
  return { start: { num: "0", den: "1" }, duration: { num: String(num), den: String(den) } };
}

/**
 * Copilot "who do I remove?" card. It owns opening the durable workflow, target
 * selection, and mask approval; detection results arrive from the owner's
 * machine through the same RPC surface, so this card never fabricates a person.
 */
export function ObjectEditPanel({
  project,
  asset,
  theme,
}: {
  project: ProjectSnapshot;
  asset: SourceAsset;
  theme: PluginSurfaceProps["theme"];
}) {
  const openEdit = useRpc(openObjectEditRpc);
  const listEdits = useRpc(listObjectEditsRpc);
  const readEdit = useRpc(getObjectEditRpc);
  const decide = useRpc(decideObjectTargetRpc);
  const reviewMask = useRpc(reviewObjectMaskRpc);
  const readMetadata = useRpc(getAssetMetadataRpc);
  const projectId = project.projectId;
  const [workflow, setWorkflow] = useState<ObjectEditWorkflow>();
  const [draft, setDraft] = useState<Record<string, "remove" | "keep">>({});
  const [maskId, setMaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const styles = useMemo(
    () => ({
      card: { gap: 6, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 8 },
      ink: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      accent: { color: theme.colors.accent },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        color: theme.colors.foreground,
        padding: 6,
        minWidth: 220,
      },
    }),
    [theme.colors],
  );

  const refresh = useCallback(async () => {
    const result = await listEdits({ projectId, assetId: asset.assetId });
    setWorkflow(result.workflows[0]);
  }, [listEdits, projectId, asset.assetId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (workflow?.state !== "analyzing") return;
    let cancelled = false;
    const timer = setInterval(() => {
      void readEdit({ projectId, workflowId: workflow.workflowId })
        .then((result) => {
          if (!cancelled) setWorkflow(result.workflow);
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workflow?.state, workflow?.workflowId, projectId, readEdit]);

  useEffect(() => {
    if (workflow?.state !== "awaiting_target_selection") return;
    const recorded = decisionsById(workflow);
    const next: Record<string, "remove" | "keep"> = {};
    for (const candidate of workflow.candidates) {
      const decision = recorded.get(candidate.objectId);
      if (decision === "remove" || decision === "keep") next[candidate.objectId] = decision;
    }
    setDraft(next);
  }, [workflow?.state, workflow?.workflowId, workflow?.workflowRevision]);

  const start = useCallback(async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const meta = await readMetadata({
        requestId: newRequestId("object-meta"),
        projectId,
        assetId: asset.assetId,
      });
      const range = rangeFromSeconds(Number(meta.durationSeconds ?? 0));
      if (!range) throw new Error("素材时长未知，无法固定对象编辑区间。");
      const result = await openEdit({
        requestId: newRequestId("object-open"),
        projectId,
        assetId: asset.assetId,
        expectedRevision: project.revision,
        sourceRange: range,
      });
      setWorkflow(result.workflow);
      setNotice("已固定素材哈希与区间，等待本机人物检测结果。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法开始对象编辑。");
    } finally {
      setBusy(false);
    }
  }, [asset.assetId, openEdit, project.revision, projectId, readMetadata]);

  const confirmTargets = useCallback(async () => {
    if (!workflow) return;
    const decisions: ObjectDecision[] = Object.entries(draft).map(([objectId, decision]) => ({
      objectId,
      decision,
    }));
    if (decisions.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await decide({
        requestId: newRequestId("object-decide"),
        projectId,
        workflowId: workflow.workflowId,
        expectedWorkflowRevision: workflow.workflowRevision,
        decisions,
      });
      setWorkflow(result.workflow);
      setNotice("已记录要移除的人，请用帧检查保存掩码后批准。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "确认目标失败。");
    } finally {
      setBusy(false);
    }
  }, [decide, draft, projectId, workflow]);

  const decideMask = useCallback(
    async (approved: boolean) => {
      if (!workflow) return;
      if (!maskId.trim()) {
        setError("请先填写已保存的掩码版本 ID。");
        return;
      }
      setBusy(true);
      setError("");
      try {
        const result = await reviewMask({
          requestId: newRequestId(approved ? "object-mask-ok" : "object-mask-no"),
          projectId,
          workflowId: workflow.workflowId,
          expectedWorkflowRevision: workflow.workflowRevision,
          maskRevisionId: maskId.trim(),
          approved,
        });
        setWorkflow(result.workflow);
        setNotice(approved ? "掩码已批准，等待去人生成与验收。" : "掩码被拒，可换一版再批准。");
      } catch (e) {
        setError(e instanceof Error ? e.message : "掩码评审失败。");
      } finally {
        setBusy(false);
      }
    },
    [maskId, projectId, reviewMask, workflow],
  );

  const button = (label: string, press: () => void, disabled = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={press}
      style={disabled ? disabledStyle : actionStyle}
    >
      <Text style={styles.accent}>{label}</Text>
    </Pressable>
  );

  if (!workflow) {
    return (
      <View style={styles.card}>
        <Text style={styles.ink}>对象编辑（Copilot）</Text>
        <Text style={styles.muted}>
          打开一个固定素材与区间的流程，人物检测在本机运行；服务端只保存你“去掉谁”的决定。
        </Text>
        {button("开始对象编辑（整段素材）", () => void start(), busy)}
        {error !== "" && <Text style={styles.error}>{error}</Text>}
      </View>
    );
  }

  const copy = describeObjectEditState(workflow.state);
  const candidates = rankCandidates(workflow.candidates);
  const toneStyle =
    copy.tone === "error" ? styles.error : copy.tone === "done" ? styles.accent : styles.ink;

  return (
    <View style={styles.card}>
      <Text style={styles.ink}>对象编辑 · {copy.label}</Text>
      <Text style={styles.muted}>{copy.hint}</Text>
      <Text style={styles.muted}>
        资产 {workflow.assetId} · 工作流 rev {workflow.workflowRevision} · 候选 {workflow.candidates.length} 位
      </Text>
      {workflow.state === "analyzing" && (
        <View style={styles.row}>
          <Text style={toneStyle}>检测中…</Text>
          {button("刷新", () => void refresh(), busy)}
        </View>
      )}
      {workflow.state === "awaiting_target_selection" && (
        <>
          {candidates.map((candidate) => {
            const role = ROLE_LABELS[candidate.role];
            const band = RISK_LABELS[riskBand(candidate)];
            const chosen = draft[candidate.objectId];
            return (
              <View key={candidate.objectId} style={styles.row}>
                <Text style={styles.ink}>
                  {role} · 置信 {Math.round(candidate.confidence * 100)}% · {band} · 证据帧{" "}
                  {candidate.evidenceFrames.join("/")}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`去掉 ${candidate.objectId}`}
                  onPress={() => setDraft((current) => ({ ...current, [candidate.objectId]: "remove" }))}
                  style={chosen === "remove" ? actionStyle : disabledStyle}
                >
                  <Text style={styles.accent}>去掉</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`保留 ${candidate.objectId}`}
                  onPress={() => setDraft((current) => ({ ...current, [candidate.objectId]: "keep" }))}
                  style={chosen === "keep" ? actionStyle : disabledStyle}
                >
                  <Text style={styles.accent}>保留</Text>
                </Pressable>
              </View>
            );
          })}
          {button("确认选择", () => void confirmTargets(), busy || Object.keys(draft).length === 0)}
        </>
      )}
      {workflow.state === "awaiting_mask_review" && (
        <>
          <Text style={styles.muted}>
            要移除的目标 {workflow.decisions.filter((entry) => entry.decision === "remove").length} 位。
            在下方帧检查点选目标并保存掩码，把返回的掩码版本 ID 填在这里。
          </Text>
          <TextInput
            value={maskId}
            onChangeText={setMaskId}
            placeholder="掩码版本 ID"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
          />
          <View style={styles.row}>
            {button("批准掩码", () => void decideMask(true), busy)}
            {button("拒绝掩码", () => void decideMask(false), busy)}
          </View>
        </>
      )}
      {workflow.state === "awaiting_generation_review" && (
        <Text style={styles.muted}>
          掩码 {workflow.maskRevisionId ?? "?"} 已批准。去人生成与本机 QA 完成后，这里会显示残留、完整与闪烁指标。
        </Text>
      )}
      {workflow.state === "completed" && workflow.qa && (
        <Text style={styles.accent}>
          残留 {Math.round(workflow.qa.residualRatio * 1000) / 10}% · 完整{" "}
          {Math.round(workflow.qa.completeRatio * 1000) / 10}% · 闪烁{" "}
          {Math.round(workflow.qa.flickerRatio * 1000) / 10}% · {workflow.qa.frames} 帧
        </Text>
      )}
      {workflow.state === "failed" && (
        <Text style={styles.error}>{copy.hint}</Text>
      )}
      {notice !== "" && <Text style={styles.muted}>{notice}</Text>}
      {error !== "" && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}
