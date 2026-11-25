import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { decodeFramedChunk } from "../shared/bytes.js";
import {
  inspectFrameRpc,
  createMaskRevisionRpc,
  type ProjectSnapshot,
  InspectFrameHeaderSchema,
  type InspectFrameHeader,
  type InspectFrameRequest,
  type SourceAsset,
} from "../shared/contracts/v1.js";
import { digestSource, imageUri } from "./web.js";
import { MaskReview } from "./mask-review.js";

type Points = InspectFrameRequest["points"];
interface Picture {
  header: InspectFrameHeader;
  uri: string;
}
const group = { gap: 4 };
const row = { flexDirection: "row", flexWrap: "wrap" } as const;
const fill = { width: "100%", height: "100%" } as const;
const actionStyle = { padding: 8 };
const disabledStyle = { padding: 8, opacity: 0.5 };

function validFrameNumber(value: string) {
  return /^(0|[1-9]\d*)$/.test(value) && Number(value) <= 2147483647;
}

export function FrameInspector({
  project,
  refresh,
  asset,
  theme,
}: {
  project: ProjectSnapshot;
  refresh: () => Promise<void>;
  asset: SourceAsset;
  theme: PluginSurfaceProps["theme"];
}) {
  const inspect = useRpc(inspectFrameRpc);
  const saveRevision = useRpc(createMaskRevisionRpc);
  const projectId = project.projectId;
  const pendingSave = useRef({ key: "", id: "" });
  const streams = asset.streams.filter((stream) => stream.kind === "video");
  const [streamUid, setStream] = useState(streams[0]?.streamUid ?? "");
  const [ordinal, setOrdinal] = useState("0");
  const [foreground, setForeground] = useState(true);
  const [picture, setPicture] = useState<Picture>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  const styles = useMemo(
    () => ({
      ink: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      accent: { color: theme.colors.accent },
    }),
    [theme.colors],
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
  const load = useCallback(
    async (frame: number, points: Points) => {
      const token = ++serial.current;
      setBusy(true);
      setError("");
      try {
        const request = {
          projectId,
          assetId: asset.assetId,
          sourcePresentationIndexHash: asset.presentationIndex.sha256,
          streamUid,
          frame,
          points,
        };
        const { metadata, payload } = decodeFramedChunk(await inspect(request));
        const header = InspectFrameHeaderSchema.parse(
          JSON.parse(new TextDecoder().decode(metadata)),
        );
        if (
          header.projectId !== projectId ||
          header.assetId !== asset.assetId ||
          header.sourceSha256 !== asset.original.sha256 ||
          header.sourcePresentationIndexHash !== request.sourcePresentationIndexHash ||
          header.streamUid !== streamUid ||
          header.frame !== frame ||
          header.points.length !== points.length ||
          header.points.some(
            (p, i) =>
              p.x !== points[i]?.x ||
              p.y !== points[i]?.y ||
              p.foreground !== points[i]?.foreground,
          ) ||
          Boolean(header.mask) !== Boolean(points.length) ||
          header.previewSha256 !== (await digestSource(Uint8Array.from(payload).buffer))
        )
          throw new Error("源帧或图像摘要与请求不一致。");
        if (token === serial.current) setPicture({ header, uri: imageUri(payload) });
      } catch (e) {
        if (token === serial.current) setError(e instanceof Error ? e.message : "读取源帧失败。");
      } finally {
        if (token === serial.current) setBusy(false);
      }
    },
    [asset, projectId, streamUid, inspect],
  );
  const h = picture?.header;
  const sameFrame = String(h?.frame) === ordinal;
  async function save() {
    if (!h?.mask || !sameFrame) return;
    const key = [
      project.revision,
      h.previewSha256,
      h.mask.labelSha256,
      JSON.stringify(h.points),
      h.frame,
      h.streamUid,
    ].join("|");
    if (pendingSave.current.key !== key)
      pendingSave.current = {
        key,
        id: `mask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      };
    setBusy(true);
    setError("");
    try {
      await saveRevision({
        requestId: pendingSave.current.id,
        expectedRevision: project.revision,
        expectedLabelSha256: h.mask.labelSha256,
        expectedPreviewSha256: h.previewSha256,
        anchor: {
          projectId,
          assetId: h.assetId,
          streamUid: h.streamUid,
          frame: h.frame,
          points: h.points,
          sourcePresentationIndexHash: h.sourcePresentationIndexHash,
        },
      });
      await refresh();
      pendingSave.current = { key: "", id: "" };
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存掩码失败。");
    } finally {
      setBusy(false);
    }
  }
  const valid = validFrameNumber(ordinal);
  return (
    <View style={group}>
      <Text style={styles.ink}>源帧与对象点选</Text>
      {streams.length > 1 && (
        <View style={row}>
          {streams.map((s) =>
            button(
              `视频流 ${s.streamIndex}`,
              () => {
                setStream(s.streamUid);
                setPicture(undefined);
                setError("");
              },
              busy || s.streamUid === streamUid,
            ),
          )}
        </View>
      )}
      <TextInput
        accessibilityLabel="源帧序号（从零开始）"
        value={ordinal}
        onChangeText={setOrdinal}
        placeholder="源帧序号（从零开始）"
        keyboardType="number-pad"
        editable={!busy}
        style={styles.ink}
      />
      {button(
        "查看源帧",
        () => {
          setForeground(true);
          void load(Number(ordinal), []);
        },
        busy || !valid,
      )}
      {busy && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          正在读取源帧或计算掩码…
        </Text>
      )}
      {error !== "" && (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      )}
      {h && picture && (
        <View>
          <Text
            style={styles.ink}
          >{`源帧 ${h.frame} / ${h.frameCount - 1} · PTS ${h.pts} × ${h.timeBase.num}/${h.timeBase.den} · ${h.width}×${h.height}`}</Text>
          <Text style={styles.muted}>
            {foreground ? "点击图中要保留的对象。" : "点击图中要排除的区域。"}
          </Text>
          <View style={row}>
            {button("添加前景点", () => setForeground(true), foreground || busy)}
            {button(
              "添加背景点",
              () => setForeground(false),
              !foreground || busy || !h.points.length,
            )}
            {button(
              "清除点选",
              () => {
                setForeground(true);
                void load(h.frame, []);
              },
              !sameFrame || !h.points.length || busy,
            )}
          </View>
          <FrameCanvas
            picture={picture}
            foreground={foreground}
            load={load}
            disabled={!sameFrame || busy}
          />
          {h.mask && (
            <>
              <Text
                style={styles.ink}
              >{`SAM2 掩码 · ${h.points.length} 个点 · ${h.mask.foregroundPixels} 个前景像素`}</Text>
              {button(
                "保存掩码供审批",
                () => {
                  void save();
                },
                busy || !sameFrame,
              )}
            </>
          )}
        </View>
      )}
      {project.approvals
        .filter(
          (a) =>
            a.subjectType === "mask_revision" &&
            a.requiredInputs.some((i) => i.type === "asset" && i.id === asset.assetId),
        )
        .map((a) => (
          <MaskReview
            key={a.approvalId}
            approval={a}
            timeline={project.revision}
            refresh={refresh}
            theme={theme}
          />
        ))}
    </View>
  );
}

function FrameCanvas({
  picture,
  foreground,
  load,
  disabled,
}: {
  picture: Picture;
  foreground: boolean;
  load: (frame: number, points: Points) => Promise<void>;
  disabled: boolean;
}) {
  const h = picture.header;
  const layout = useRef({ width: 0, height: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    layout.current = event.nativeEvent.layout;
  }, []);
  const onPress = useCallback(
    (event: GestureResponderEvent) => {
      let { width, height } = layout.current;
      let { locationX, locationY } = event.nativeEvent;
      // react-native-web dispatches a native click here, with viewport coordinates.
      if (
        typeof Element !== "undefined" &&
        event.currentTarget instanceof Element &&
        "clientX" in event.nativeEvent
      ) {
        const rect = event.currentTarget.getBoundingClientRect();
        const pointer = event.nativeEvent as unknown as MouseEvent;
        locationX = pointer.clientX - rect.left;
        locationY = pointer.clientY - rect.top;
        width = rect.width;
        height = rect.height;
      }
      if (!Number.isFinite(locationX) || !Number.isFinite(locationY) || width <= 0 || height <= 0)
        return;
      const x = Math.min(h.width - 1, Math.max(0, Math.floor((locationX * h.width) / width)));
      const y = Math.min(h.height - 1, Math.max(0, Math.floor((locationY * h.height) / height)));
      void load(h.frame, [...h.points, { x, y, foreground }]);
    },
    [h, foreground, load],
  );
  const frameStyle = useMemo(
    () => ({
      width: "100%" as const,
      maxWidth: h.previewWidth,
      aspectRatio: h.previewWidth / h.previewHeight,
    }),
    [h.previewWidth, h.previewHeight],
  );
  const source = useMemo(() => ({ uri: picture.uri }), [picture.uri]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="点选源帧"
      disabled={disabled || h.points.length >= 32}
      style={frameStyle}
      onLayout={onLayout}
      onPress={onPress}
    >
      <View pointerEvents="none" style={fill}>
        <Image accessibilityLabel="源帧预览图" resizeMode="stretch" source={source} style={fill} />
      </View>
    </Pressable>
  );
}
