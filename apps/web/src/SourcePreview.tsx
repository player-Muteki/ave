import React, { useEffect, useState } from "react";
import { AveClient, downloadArtifactBytes, MAX_DESK_SOURCE_BYTES } from "@ave/client-sdk";
import type { SourceAsset } from "@ave/contracts";
import { formatError } from "./workbench-state.js";

interface Props {
  client: AveClient;
  projectId: string;
  revision: string;
  asset: SourceAsset;
}

export function SourcePreview({ client, projectId, revision, asset }: Props) {
  const large = BigInt(asset.original.bytes) > BigInt(MAX_DESK_SOURCE_BYTES);
  const [proxy, setProxy] = useState(() => Boolean(asset.proxy) &&
    (large || !document.createElement("video").canPlayType(asset.original.mediaType)));
  const [loadOriginal, setLoadOriginal] = useState(false);
  const [media, setMedia] = useState<{ hash: string; url: string }>();
  const [error, setError] = useState("");
  const blob = proxy && asset.proxy ? asset.proxy : asset.original;
  const id = proxy ? asset.assetId + ".proxy" : asset.assetId;
  const deferred = large && !proxy && !loadOriginal;

  useEffect(() => {
    if (deferred || media?.hash === blob.sha256) return;
    const controller = new AbortController();
    setError("");
    void (async () => {
      const result = await downloadArtifactBytes(client, { projectId, assetId: id, revision, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.sha256 !== blob.sha256) throw new Error("素材预览校验失败。");
      const video = new Blob([result.bytes.slice().buffer], { type: blob.mediaType });
      setMedia({ hash: result.sha256, url: URL.createObjectURL(video) });
    })().catch(reason => { if (!controller.signal.aborted) setError(formatError(reason)); });
    return () => controller.abort();
  }, [client, projectId, id, revision, blob.sha256, blob.mediaType, deferred, media?.hash]);
  useEffect(() => () => { if (media) URL.revokeObjectURL(media.url); }, [media]);

  if (deferred) return <button onClick={() => setLoadOriginal(true)}>加载原片预览</button>;
  if (error) return <p role="alert">素材预览失败 · {error}</p>;
  if (!media || media.hash !== blob.sha256) return <p role="status">正在加载素材预览…</p>;
  return <figure style={{ margin: "12px 0" }}>
    <video aria-label="素材预览" src={media.url} controls playsInline preload="auto"
      style={{ display: "block", width: "100%", maxHeight: 260, background: "#000", borderRadius: 8 }}
      onError={() => {
        if (!proxy && asset.proxy && asset.proxy.sha256 !== blob.sha256) setProxy(true);
        else setError("播放器不支持此视频编码。");
      }} />
    <figcaption>{asset.displayName}{proxy && " · 无声预览"}</figcaption>
  </figure>;
}
