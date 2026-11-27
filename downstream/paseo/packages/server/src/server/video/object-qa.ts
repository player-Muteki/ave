import { OBJECT_EDIT_QA_LIMITS, ObjectQaReportSchema, type ObjectQaReport } from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";

/**
 * Removal QA is server-owned. A daemon reports measured ratios; the thresholds
 * live here so a worker runtime cannot upgrade its own pass/fail policy.
 */

export type ObjectQaMetric = "residual" | "complete" | "flicker";

export interface ObjectQaCheck {
  metric: ObjectQaMetric;
  measured: number;
  threshold: number;
  passed: boolean;
}

export interface ObjectQaVerdict {
  passed: boolean;
  checks: ObjectQaCheck[];
  failed: ObjectQaMetric[];
}

export function parseObjectQa(value: unknown): ObjectQaReport {
  const parsed = ObjectQaReportSchema.safeParse(value);
  if (!parsed.success)
    editorFailure("INVALID_ARGUMENT", "The QA report does not match the wire contract");
  if (parsed.data.frames === "0")
    editorFailure("INVALID_ARGUMENT", "A QA report must cover at least one frame");
  return parsed.data;
}

export function evaluateObjectQa(report: ObjectQaReport): ObjectQaVerdict {
  if (report.frames === "0")
    editorFailure("INVALID_ARGUMENT", "A QA report must cover at least one frame");
  const residual: ObjectQaCheck = {
    metric: "residual",
    measured: report.residualRatio,
    threshold: OBJECT_EDIT_QA_LIMITS.residualRatioMax,
    passed: report.residualRatio <= OBJECT_EDIT_QA_LIMITS.residualRatioMax,
  };
  const complete: ObjectQaCheck = {
    metric: "complete",
    measured: report.completeRatio,
    threshold: OBJECT_EDIT_QA_LIMITS.completeRatioMin,
    passed: report.completeRatio >= OBJECT_EDIT_QA_LIMITS.completeRatioMin,
  };
  const flicker: ObjectQaCheck = {
    metric: "flicker",
    measured: report.flickerRatio,
    threshold: OBJECT_EDIT_QA_LIMITS.flickerRatioMax,
    passed: report.flickerRatio <= OBJECT_EDIT_QA_LIMITS.flickerRatioMax,
  };
  const checks = [residual, complete, flicker];
  const failed = checks.filter((check) => !check.passed).map((check) => check.metric);
  return { passed: failed.length === 0, checks, failed };
}
