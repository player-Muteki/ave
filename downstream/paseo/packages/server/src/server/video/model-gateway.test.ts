import { describe, expect, it } from "vitest";
import { EditorError } from "./errors.js";
import {
  ALLOWED_MODEL_LICENSES,
  MODEL_REGISTRY,
  eligibleModels,
  nextFallback,
  routeModel,
  type ModelProfile,
} from "./model-gateway.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof EditorError) return error.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("model gateway", () => {
  it("keeps the registry Apache-2.0 only", () => {
    for (const model of MODEL_REGISTRY) {
      expect(ALLOWED_MODEL_LICENSES).toContain(model.license);
      expect(model.license).not.toBe("AGPL-3.0");
    }
  });

  it("routes detection to the licensed priority order with fallbacks", () => {
    const route = routeModel("detect");
    expect(route.primary.id).toBe("yolox-tiny-onnx");
    expect(route.fallbacks.map((model) => model.id)).toEqual(["rtdetr-l-onnx", "opencv-hog"]);
    expect(routeModel("segment").primary.id).toBe("sam2.1-tiny");
    expect(routeModel("qa").primary.id).toBe("masked-shot-qa");
  });

  it("honours builtin-only and frame-limit requirements", () => {
    expect(routeModel("detect", { requireBuiltin: true }).primary.id).toBe("opencv-hog");
    expect(routeModel("segment", { maxFrames: 81 }).primary.id).toBe("sam2.1-tiny");
    expect(codeOf(() => routeModel("generate", { maxFrames: 81 }))).toBe("CAPABILITY_UNAVAILABLE");
    expect(routeModel("generate").primary.maxFrames).toBe(9);
  });

  it("skips unavailable models and AGPL entries in a caller-supplied registry", () => {
    const registry: ModelProfile[] = [
      {
        id: "ultralytics-yolo",
        stage: "detect",
        engine: "ultralytics",
        license: "AGPL-3.0" as ModelProfile["license"],
        weights: "caller-supplied",
        maxFrames: 81,
        priority: 1,
        available: true,
      },
      {
        id: "offline",
        stage: "detect",
        engine: "onnx",
        license: "Apache-2.0",
        weights: "caller-supplied",
        maxFrames: 81,
        priority: 2,
        available: false,
      },
      {
        id: "rtdetr",
        stage: "detect",
        engine: "onnx",
        license: "Apache-2.0",
        weights: "caller-supplied",
        maxFrames: 81,
        priority: 3,
        available: true,
      },
    ];
    const eligible = eligibleModels("detect", {}, registry);
    expect(eligible.map((model) => model.id)).toEqual(["rtdetr"]);
    expect(routeModel("detect", {}, registry).primary.id).toBe("rtdetr");
  });

  it("walks fallbacks once and fails closed when exhausted", () => {
    const route = routeModel("detect");
    expect(nextFallback(route, []).id).toBe("rtdetr-l-onnx");
    expect(nextFallback(route, ["rtdetr-l-onnx"]).id).toBe("opencv-hog");
    expect(codeOf(() => nextFallback(route, ["rtdetr-l-onnx", "opencv-hog"]))).toBe(
      "CAPABILITY_UNAVAILABLE",
    );
  });
});
