import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { proposeVacePreviewRpc, type ApprovalRequest } from "../shared/contracts/v1.js";

interface Props {
  approval: ApprovalRequest;
  refresh: () => Promise<void>;
  theme: PluginSurfaceProps["theme"];
  disabled: boolean;
}
export function VaceForm({ approval, refresh, theme, disabled }: Props) {
  const propose = useRpc(proposeVacePreviewRpc);
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [seed, setSeed] = useState("732021");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const receipt = useRef({ key: "", id: "" });
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      action: { color: theme.colors.accent, paddingVertical: 8 },
    }),
    [theme.colors],
  );
  const submit = useCallback(async () => {
    const fields = {
      projectId: approval.projectId,
      expectedRevision: approval.baseTimelineRevision,
      maskApprovalId: approval.approvalId,
      manifestHash: approval.subjectHash,
      prompt: prompt.trim(),
      negativePrompt: negative,
      seed: Number(seed),
    };
    const key = JSON.stringify(fields);
    if (receipt.current.key !== key)
      receipt.current = {
        key,
        id: `vace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      };
    setBusy(true);
    setError("");
    try {
      await propose({ ...fields, requestId: receipt.current.id });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成方案提交失败。");
    } finally {
      setBusy(false);
    }
  }, [approval, negative, prompt, propose, refresh, seed]);
  return (
    <View>
      <Text style={styles.text}>VACE 对象编辑提示词</Text>
      <TextInput
        accessibilityLabel="VACE 提示词"
        value={prompt}
        onChangeText={setPrompt}
        maxLength={2048}
        style={styles.text}
      />
      <Text style={styles.text}>负面提示词（可空）</Text>
      <TextInput
        accessibilityLabel="VACE 负面提示词"
        value={negative}
        onChangeText={setNegative}
        maxLength={2048}
        style={styles.text}
      />
      <Text style={styles.text}>生成种子</Text>
      <TextInput
        accessibilityLabel="VACE 种子"
        value={seed}
        onChangeText={setSeed}
        keyboardType="number-pad"
        style={styles.text}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="提交 VACE 预览方案"
        onPress={submit}
        disabled={
          disabled || busy || !prompt.trim() || !/^\d+$/.test(seed) || Number(seed) > 4294967295
        }
      >
        <Text style={styles.action}>提交 VACE 预览方案</Text>
      </Pressable>
      {!!error && (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {error}
        </Text>
      )}
    </View>
  );
}
