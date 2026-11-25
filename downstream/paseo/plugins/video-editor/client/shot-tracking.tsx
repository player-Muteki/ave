import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getJobRpc, trackMaskRpc, type ApprovalRequest } from "../shared/contracts/v1.js";

export function ShotTracking({
  approval,
  anchor,
  length,
  refresh,
  theme,
}: {
  approval: ApprovalRequest;
  anchor: number;
  length: number;
  refresh: () => Promise<void>;
  theme: PluginSurfaceProps["theme"];
}) {
  const count = Math.min(9, length);
  const [first, setFirst] = useState(
    String(Math.max(0, Math.min(anchor - Math.floor(count / 2), length - count))),
  );
  const [frames, setFrames] = useState(String(count));
  const [jobId, setJobId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const start = useRpc(trackMaskRpc);
  const get = useRpc(getJobRpc);
  const { projectId, approvalId, subjectHash, baseTimelineRevision } = approval;
  const stop = Number(first) + Number(frames);
  const valid =
    /^\d+$/.test(first) &&
    /^\d+$/.test(frames) &&
    Number(frames) >= 2 &&
    Number(frames) <= 81 &&
    Number(first) <= anchor &&
    anchor < stop &&
    stop <= length;
  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const result = await start({
        requestId: `track-${approvalId}-${Number(first)}-${Number(frames)}`,
        projectId,
        expectedRevision: baseTimelineRevision,
        anchorApprovalId: approvalId,
        anchorHash: subjectHash,
        firstFrame: Number(first),
        frameCount: Number(frames),
      });
      setJobId(result.job.jobId);
      setMessage(result.job.phaseDetail ?? result.job.state);
      await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "传播请求失败。");
    } finally {
      setSubmitting(false);
    }
  }, [approvalId, baseTimelineRevision, first, frames, projectId, refresh, start, subjectHash]);
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const job = await get({ projectId, jobId });
        if (!live) return;
        setMessage(job.error?.sanitizedDetail ?? job.phaseDetail ?? job.state);
        if (
          job.state === "analyzing" ||
          job.state === "cancel_requested" ||
          job.state === "pausing"
        )
          timer = setTimeout(poll, 800);
        else {
          setJobId("");
          await refresh();
        }
      } catch (e) {
        if (live) {
          setJobId("");
          setMessage(e instanceof Error ? e.message : "读取任务失败。");
        }
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [get, jobId, projectId, refresh]);
  const style = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      action: { color: theme.colors.accent, paddingVertical: 8 },
    }),
    [theme.colors],
  );
  return (
    <View>
      <Text style={style.text}>传播起始源帧（从零开始）</Text>
      <TextInput
        accessibilityLabel="传播起始源帧"
        value={first}
        onChangeText={setFirst}
        keyboardType="number-pad"
        style={style.text}
      />
      <Text style={style.text}>传播帧数（2–81，须包含锚帧 {anchor}）</Text>
      <TextInput
        accessibilityLabel="传播帧数"
        value={frames}
        onChangeText={setFrames}
        keyboardType="number-pad"
        style={style.text}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="传播已批准的掩码"
        disabled={!valid || submitting || !!jobId}
        onPress={submit}
      >
        <Text style={style.action}>传播已批准的掩码</Text>
      </Pressable>
      {message !== "" && (
        <Text accessibilityLiveRegion="polite" style={style.text}>
          {message}
        </Text>
      )}
    </View>
  );
}
