import { Platform } from "react-native";
import type { DeskSource } from "./import-source.js";

// The input belongs to this screen. Closing its native dialog never starts a pending operation.
export function mountSourcePicker(parent: unknown, onSelected: (file: DeskSource) => void) {
  if (Platform.OS !== "web" || !(parent instanceof HTMLElement)) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*,.mkv,.mov,.webm,.mp4";
  input.setAttribute("aria-label", "选择本机视频");
  input.style.maxWidth = "100%";
  input.style.color = "inherit";
  const changed = () => {
    const file = input.files?.[0];
    if (!file) return;
    input.value = ""; // Allow picking the same file again as a separate import.
    onSelected(file);
  };
  input.addEventListener("change", changed);
  parent.appendChild(input);
  return () => {
    input.removeEventListener("change", changed);
    input.remove();
  };
}

export function mountReviewVideo(parent: unknown, bytes: ArrayBuffer, label: string, onError: () => void) {
  if (Platform.OS !== "web" || !(parent instanceof HTMLElement)) throw new Error("当前工作台无法显示视频。");
  const video = document.createElement("video");
  const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.style.width = "100%";
  video.style.maxHeight = "60vh";
  video.setAttribute("aria-label", label);
  video.addEventListener("error", onError);
  video.src = url;
  parent.appendChild(video);
  return () => {
    video.removeEventListener("error", onError);
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  };
}

export function mountDeliveryLink(parent: unknown, bytes: ArrayBuffer, purpose: "export" | "manifest" | "qa" | "contact", sha256: string) {
  if (Platform.OS !== "web" || !(parent instanceof HTMLElement) || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("当前工作台无法保存交付文件。");
  if (purpose === "contact") {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    img.alt = `contact sheet ${sha256.slice(0, 12)}`;
    img.style.maxWidth = "100%";
    parent.appendChild(img);
    return () => { img.remove(); URL.revokeObjectURL(img.src); };
  }
  const manifest = purpose === "manifest" || purpose === "qa";
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([bytes], { type: manifest ? "application/json" : "video/mp4" }));
  link.href = url;
  link.download = `${purpose}-${sha256.slice(0, 12)}.${manifest ? "json" : "mp4"}`;
  link.textContent = manifest ? "保存导出清单（JSON）" : "保存成品视频（MP4）";
  link.style.color = "inherit";
  parent.appendChild(link);
  return () => { link.remove(); URL.revokeObjectURL(url); };
}

export async function digestSource(bytes: ArrayBuffer): Promise<string> {
  if (Platform.OS !== "web" || !globalThis.crypto?.subtle) throw new Error("当前工作台不支持文件校验。");
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}
