import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { readAssetChunkRpc, type BlobRef } from "../shared/contracts/v1.js";
import { readReviewBytes } from "./review-bytes.js";
import { digestSource, mountReviewVideo, mountDeliveryLink } from "./web.js";

interface ReviewProps {
  projectId: string;
  assetId: string;
  revision: string;
  blob: BlobRef;
  label: string;
  theme: PluginSurfaceProps["theme"];
  purpose?: "play" | "export" | "manifest" | "qa" | "contact";
}

export function ReviewPlayer({projectId, assetId, revision, blob, label, theme, purpose = "play"}: ReviewProps) {
  const read = useRpc(readAssetChunkRpc);
  const parent = useRef<View>(null);
  const [message, setMessage] = useState("");
  const {bytes, sha256, mediaType} = blob;
  const messageStyle = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme.colors.foregroundMuted]);
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setMessage("正在读取并校验文件…");
    void readReviewBytes({projectId, assetId, revision, blob: {bytes, sha256, mediaType}}, read, digestSource, controller.signal, purpose)
      .then(data => {
        if (controller.signal.aborted) return undefined;
        if (purpose !== "play") {
          dispose = mountDeliveryLink(parent.current, data, purpose, sha256);
          setMessage("文件已校验，点击下方链接保存。");
          return dispose;
        }
        dispose = mountReviewVideo(parent.current, data, label, () => setMessage("浏览器无法解码这段视频。"));
        setMessage("视频校验通过，可播放或拖动进度条。");
        return dispose;
      }).catch((e:unknown) => {
        if (!controller.signal.aborted) setMessage(e instanceof Error ? e.message : "无法读取文件。");
      });
    return () => {controller.abort(); dispose?.();};
  }, [projectId, assetId, revision, bytes, sha256, mediaType, read, label, purpose]);
  return <View>
    <Text accessibilityLiveRegion="polite" style={messageStyle}>{message}</Text>
    <View ref={parent} collapsable={false} />
  </View>;
}
