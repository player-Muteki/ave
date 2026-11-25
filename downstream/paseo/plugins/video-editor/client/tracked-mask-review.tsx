import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  decideApprovalRpc,
  requestTrackedMaskReviewRpc,
  type ArtifactRef,
  type JobSnapshot,
  type ProjectSnapshot,
} from "../shared/contracts/v1.js";
import { VaceForm } from "./vace-form.js";
import { ReviewPlayer } from "./review-player.js";

interface Props {
  project: ProjectSnapshot;
  job: JobSnapshot;
  refresh: () => Promise<void>;
  theme: PluginSurfaceProps["theme"];
}

export function TrackedMaskReview(props: Props) {
  const { job, project } = props;
  const find = (kind: ArtifactRef["kind"], suffix: string) =>
    job.artifacts.find(
      (a) =>
        a.kind === kind &&
        a.projectId === project.projectId &&
        a.jobId === job.jobId &&
        a.revision === job.revision &&
        a.artifactId === job.jobId + suffix,
    );
  const manifest = find("mask", ":tracked-mask");
  const proxy = find("proxy", ":tracking-preview");
  if (!manifest || !proxy) return null;
  return (
    <Review
      key={manifest.blob.sha256 + proxy.blob.sha256}
      {...props}
      manifest={manifest}
      proxy={proxy}
    />
  );
}

function statusText(status: string | undefined, pending: boolean) {
  if (status === "approved") return "整段掩码已批准";
  if (status === "rejected") return "整段掩码已拒绝";
  return pending ? "等待整段掩码审批" : "审批已失效";
}

function Review({
  project,
  job,
  theme,
  refresh,
  manifest,
  proxy,
}: Props & { manifest: ArtifactRef; proxy: ArtifactRef }) {
  const request = useRpc(requestTrackedMaskReviewRpc);
  const decide = useRpc(decideApprovalRpc);
  const [open, setOpen] = useState(false);
  const [played, setPlayed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ended = useCallback(() => setPlayed(true), []);
  const approval = project.approvals.findLast(
    (a) =>
      a.purpose === "input" &&
      a.subjectType === "mask_revision" &&
      a.subjectId === manifest.artifactId &&
      a.subjectHash === manifest.blob.sha256 &&
      a.baseTimelineRevision === job.revision &&
      a.requiredInputs.some(
        (i) =>
          i.type === "review_proxy" &&
          i.id === proxy.artifactId &&
          i.revision === proxy.revision &&
          i.hash === proxy.blob.sha256,
      ),
  );
  const pending = approval?.status === "pending" && Date.parse(approval.expiresAt) > Date.now();
  const locked = busy || project.revision !== job.revision;
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      enabled: { color: theme.colors.accent, paddingVertical: 8 },
      disabled: { color: theme.colors.foregroundMuted, paddingVertical: 8 },
    }),
    [theme.colors],
  );
  const status = statusText(approval?.status, pending);
  const action = async (choice: "submit" | "approve" | "reject") => {
    setBusy(true);
    setError("");
    try {
      if (choice === "submit") {
        await request({
          projectId: project.projectId,
          jobId: job.jobId,
          expectedRevision: job.revision,
          requestId: `review-${job.jobId}-${approval?.approvalId ?? "first"}`,
          manifestHash: manifest.blob.sha256,
          reviewHash: proxy.blob.sha256,
        });
      } else if (approval && pending) {
        await decide({
          approvalId: approval.approvalId,
          expectedRevision: job.revision,
          decision: choice,
          requestId: `${choice}-${approval.approvalId}`,
        });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "掩码审批失败。");
    } finally {
      setBusy(false);
    }
  };
  const button = (label: string, click: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={click}
    >
      <Text style={disabled ? styles.disabled : styles.enabled}>{label}</Text>
    </Pressable>
  );
  const label = "播放掩码传播审片（9 帧/秒）";
  return (
    <View>
      {button(open ? "关闭掩码播放器" : label, () => setOpen(!open))}
      {open && (
        <ReviewPlayer
          projectId={project.projectId}
          assetId={proxy.artifactId}
          revision={proxy.revision}
          blob={proxy.blob}
          label={label}
          theme={theme}
          onEnded={ended}
        />
      )}
      {approval && (
        <Text style={styles.text}>
          {approval.diffSummary.summary} · {status}
        </Text>
      )}
      {pending && (
        <View>
          <Text selectable style={styles.text}>
            掩码清单 SHA-256 {manifest.blob.sha256}
          </Text>
          {!played && <Text style={styles.text}>播放审片至片尾后可批准这段掩码。</Text>}
          {button("批准整段掩码作为输入", () => void action("approve"), locked || !played)}
          {button("拒绝整段掩码", () => void action("reject"), locked)}
        </View>
      )}
      {!pending &&
        approval?.status !== "approved" &&
        button(
          approval ? "重新提交整段掩码审批" : "提交整段掩码审批",
          () => void action("submit"),
          locked,
        )}
      {approval?.status === "approved" && approval.diffSummary.operationCount === 9 && (
        <VaceForm approval={approval} refresh={refresh} theme={theme} disabled={locked} />
      )}
      {!!error && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {error}
        </Text>
      )}
    </View>
  );
}
