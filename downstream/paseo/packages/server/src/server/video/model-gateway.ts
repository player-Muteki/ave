import { editorFailure } from "./errors.js";

/**
 * P1 model gateway: one registry decides which model may serve which stage.
 * Licenses are a hard filter (no AGPL/Ultralytics entries), availability is
 * runtime state, and maxFrames keeps a long shot from being routed to the
 * nine-frame generator by accident.
 */

export type ModelStage = "detect" | "segment" | "generate" | "qa";

export const ALLOWED_MODEL_LICENSES = ["Apache-2.0", "BSD-3-Clause", "MIT"] as const;
export type ModelLicense = (typeof ALLOWED_MODEL_LICENSES)[number];

export interface ModelProfile {
  id: string;
  stage: ModelStage;
  engine: string;
  license: ModelLicense;
  weights: "builtin" | "caller-supplied";
  maxFrames: number;
  priority: number;
  available: boolean;
}

/** Apache-2.0 only, matching the P0 decision to avoid Ultralytics AGPL weights. */
export const MODEL_REGISTRY: readonly ModelProfile[] = [
  {
    id: "yolox-tiny-onnx",
    stage: "detect",
    engine: "yolox",
    license: "Apache-2.0",
    weights: "caller-supplied",
    maxFrames: 81,
    priority: 1,
    available: true,
  },
  {
    id: "rtdetr-l-onnx",
    stage: "detect",
    engine: "rtdetr",
    license: "Apache-2.0",
    weights: "caller-supplied",
    maxFrames: 81,
    priority: 2,
    available: true,
  },
  {
    id: "opencv-hog",
    stage: "detect",
    engine: "hog",
    license: "Apache-2.0",
    weights: "builtin",
    maxFrames: 81,
    priority: 3,
    available: true,
  },
  {
    id: "sam2.1-tiny",
    stage: "segment",
    engine: "sam2",
    license: "Apache-2.0",
    weights: "builtin",
    maxFrames: 81,
    priority: 1,
    available: true,
  },
  {
    id: "sam2.1-small",
    stage: "segment",
    engine: "sam2",
    license: "Apache-2.0",
    weights: "builtin",
    maxFrames: 81,
    priority: 2,
    available: true,
  },
  {
    id: "vace-1.3b",
    stage: "generate",
    engine: "vace",
    license: "Apache-2.0",
    weights: "caller-supplied",
    maxFrames: 9,
    priority: 1,
    available: true,
  },
  {
    id: "masked-shot-qa",
    stage: "qa",
    engine: "deterministic-metrics",
    license: "Apache-2.0",
    weights: "builtin",
    maxFrames: 81,
    priority: 1,
    available: true,
  },
];

export interface ModelRequirements {
  maxFrames?: number;
  requireBuiltin?: boolean;
}

export interface ModelRoute {
  stage: ModelStage;
  primary: ModelProfile;
  fallbacks: ModelProfile[];
}

export function eligibleModels(
  stage: ModelStage,
  requirements: ModelRequirements = {},
  registry: readonly ModelProfile[] = MODEL_REGISTRY,
): ModelProfile[] {
  return registry
    .filter(
      (model) =>
        model.stage === stage &&
        ALLOWED_MODEL_LICENSES.includes(model.license) &&
        model.available &&
        (requirements.maxFrames === undefined || model.maxFrames >= requirements.maxFrames) &&
        (!requirements.requireBuiltin || model.weights === "builtin"),
    )
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export function routeModel(
  stage: ModelStage,
  requirements: ModelRequirements = {},
  registry: readonly ModelProfile[] = MODEL_REGISTRY,
): ModelRoute {
  const eligible = eligibleModels(stage, requirements, registry);
  if (eligible.length === 0)
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      `No licensed model can serve ${stage} under the requested limits`,
    );
  return { stage, primary: eligible[0]!, fallbacks: eligible.slice(1) };
}

/** Advance past a failed model without repeating it; exhausted route fails. */
export function nextFallback(route: ModelRoute, failedIds: readonly string[]): ModelProfile {
  const candidate = route.fallbacks.find((model) => !failedIds.includes(model.id));
  if (!candidate)
    editorFailure(
      "CAPABILITY_UNAVAILABLE",
      `Every ${route.stage} model failed; no fallback remains`,
    );
  return candidate;
}
