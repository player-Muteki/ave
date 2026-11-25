import { useCallback, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { decodeFramedChunk } from "../shared/bytes.js";
import {
  decideApprovalRpc,
  getMaskRevisionRpc,
  MaskAnchorRevisionSchema,
  type ApprovalRequest,
} from "../shared/contracts/v1.js";
import { digestSource, imageUri } from "./web.js";

export function MaskReview({
  approval,
  timeline,
  refresh,
  theme,
}: {
  approval: ApprovalRequest;
  timeline: string;
  refresh: () => Promise<void>;
  theme: PluginSurfaceProps["theme"];
}) {
  const read = useRpc(getMaskRevisionRpc);
  const decide = useRpc(decideApprovalRpc);
  const [picture, setPicture] = useState<{ uri: string; width: number; height: number }>();
  const [decoded, setDecoded] = useState(false);
  const loaded = useCallback(() => setDecoded(true), []);
  const failed = useCallback(() => {
    setDecoded(false);
    setError("无法解码保存的掩码审片图。");
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      action: { color: theme.colors.accent, padding: 8 },
      error: { color: theme.colors.statusDanger },
      image: {
        width: "100%" as const,
        maxWidth: picture?.width,
        aspectRatio: picture ? picture.width / picture.height : 1,
      },
    }),
    [theme.colors, picture],
  );
  const image = useMemo(() => picture && { uri: picture.uri }, [picture]);
  const run = useCallback(
    async (kind: "read" | "approve" | "reject") => {
      async function review() {
        const packet = await read({
          projectId: approval.projectId,
          maskRevisionId: approval.subjectId,
        });
        const { metadata, payload } = decodeFramedChunk(packet);
        if ((await digestSource(Uint8Array.from(metadata).buffer)) !== approval.subjectHash)
          throw new Error("掩码版本与审批摘要不一致。");
        const revision = MaskAnchorRevisionSchema.parse(
          JSON.parse(new TextDecoder().decode(metadata)),
        );
        if (
          revision.projectId !== approval.projectId ||
          revision.maskRevisionId !== approval.subjectId ||
          revision.reviewImage.sha256 !== (await digestSource(Uint8Array.from(payload).buffer))
        )
          throw new Error("掩码审片图校验失败。");
        setPicture({
          uri: imageUri(payload),
          width: revision.anchor.previewWidth,
          height: revision.anchor.previewHeight,
        });
      }
      async function decision(value: "approve" | "reject") {
        await decide({
          approvalId: approval.approvalId,
          expectedRevision: timeline,
          decision: value,
          requestId: `mask-${value}-${approval.approvalId}`,
        });
        await refresh();
      }
      setBusy(true);
      setError("");
      try {
        if (kind === "read") await review();
        else await decision(kind);
      } catch (e) {
        setError(e instanceof Error ? e.message : "掩码操作失败。");
      } finally {
        setBusy(false);
      }
    },
    [approval, read, decide, timeline, refresh],
  );
  const expired = approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.now();
  const canDecide =
    decoded &&
    !expired &&
    approval.status === "pending" &&
    approval.baseTimelineRevision === timeline;
  const status = {
    pending: "待审批",
    approved: "已批准",
    rejected: "已拒绝",
    superseded: "已替代",
    expired: "已过期",
    revoked: "已撤销",
  }[expired ? "expired" : approval.status];
  return (
    <View>
      <Text style={styles.text}>
        {approval.diffSummary.summary} · 输入掩码{status}
      </Text>
      <Action label="查看保存的掩码" kind="read" busy={busy} run={run} style={styles.action} />
      {image && (
        <Image
          accessibilityLabel="保存的掩码审片图"
          source={image}
          onLoad={loaded}
          onError={failed}
          resizeMode="contain"
          style={styles.image}
        />
      )}
      {image && canDecide && (
        <Action label="批准此输入掩码" kind="approve" busy={busy} run={run} style={styles.action} />
      )}
      {image && canDecide && (
        <Action label="拒绝此输入掩码" kind="reject" busy={busy} run={run} style={styles.action} />
      )}
      {error !== "" && (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

function Action({
  label,
  kind,
  busy,
  run,
  style,
}: {
  label: string;
  kind: "read" | "approve" | "reject";
  busy: boolean;
  run: (kind: "read" | "approve" | "reject") => Promise<void>;
  style: { color: string; padding: number };
}) {
  const press = useCallback(() => {
    void run(kind);
  }, [run, kind]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={press}
      disabled={busy}
    >
      <Text style={style}>{label}</Text>
    </Pressable>
  );
}
