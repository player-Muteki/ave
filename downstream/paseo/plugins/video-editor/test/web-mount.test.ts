import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountDeliveryLink, mountReviewVideo, mountSourcePicker } from "../client/web.js";

// The mount* adapters are the shared desktop/web pure-DOM delivery UI (goal:
// shared desktop UI). Node ships Blob + URL.createObjectURL; only document and
// HTMLElement need stubbing. Pins the platform/parent gates, the delivery-link
// sha256 guard and the purpose-based download naming.

function makeElement(tag: string) {
  return {
    tag, style: {} as Record<string, unknown>, attrs: {} as Record<string, string>,
    children: [] as unknown[], removed: false,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c: unknown) { this.children.push(c); },
    remove() { this.removed = true; },
    pause() {}, load() {},
  };
}

class FakeHTMLElement { children: unknown[] = []; appendChild(c: unknown) { this.children.push(c); } }

const originalHTMLElement = (globalThis as Record<string, unknown>).HTMLElement;
const originalDocument = (globalThis as Record<string, unknown>).document;

beforeAll(() => {
  (globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
  (globalThis as Record<string, unknown>).document = { createElement: makeElement };
});
afterAll(() => {
  (globalThis as Record<string, unknown>).HTMLElement = originalHTMLElement;
  (globalThis as Record<string, unknown>).document = originalDocument;
});

const bytes = new Uint8Array(4).buffer;
const SHA = "a".repeat(64);

describe("mountDeliveryLink", () => {
  it("names the export download by purpose and the first 12 hash chars", () => {
    const parent = new FakeHTMLElement();
    const cleanup = mountDeliveryLink(parent, bytes, "export", SHA) as () => void;
    const link = parent.children[0] as ReturnType<typeof makeElement>;
    expect(link.download).toBe(`export-${SHA.slice(0, 12)}.mp4`);
    expect(link.textContent).toBe("保存成品视频（MP4）");
    cleanup();
    expect(link.removed).toBe(true);
  });

  it("names the manifest download as JSON", () => {
    const parent = new FakeHTMLElement();
    mountDeliveryLink(parent, bytes, "manifest", SHA);
    const link = parent.children[0] as ReturnType<typeof makeElement>;
    expect(link.download).toBe(`manifest-${SHA.slice(0, 12)}.json`);
    expect(link.textContent).toBe("保存导出清单（JSON）");
  });

  it("rejects a malformed sha256 and a non-element parent", () => {
    const parent = new FakeHTMLElement();
    expect(() => mountDeliveryLink(parent, bytes, "export", "not-a-hash")).toThrow(/无法保存交付文件/);
    expect(() => mountDeliveryLink(parent, bytes, "export", "A".repeat(64))).toThrow(/无法保存交付文件/);
    expect(() => mountDeliveryLink({} as never, bytes, "export", SHA)).toThrow(/无法保存交付文件/);
  });
});

describe("mountReviewVideo", () => {
  it("mounts a controls-enabled video and returns a cleanup", () => {
    const parent = new FakeHTMLElement();
    const cleanup = mountReviewVideo(parent, bytes, "预览", () => {}) as () => void;
    const video = parent.children[0] as ReturnType<typeof makeElement>;
    expect(video.controls).toBe(true);
    expect(video.attrs["aria-label"]).toBe("预览");
    expect(typeof cleanup).toBe("function");
  });

  it("throws on a non-element parent", () => {
    expect(() => mountReviewVideo({} as never, bytes, "预览", () => {})).toThrow(/无法显示视频/);
  });
});

describe("mountSourcePicker", () => {
  it("mounts a video file input and returns a cleanup", () => {
    const parent = new FakeHTMLElement();
    const cleanup = mountSourcePicker(parent, () => {}) as () => void;
    const input = parent.children[0] as ReturnType<typeof makeElement>;
    expect(input.type).toBe("file");
    expect(input.attrs["aria-label"]).toBe("选择本机视频");
    expect(typeof cleanup).toBe("function");
  });

  it("is a no-op on a non-element parent", () => {
    expect(mountSourcePicker({} as never, () => {})).toBeUndefined();
  });
});