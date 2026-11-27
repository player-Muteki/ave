import type { ObjectCandidate, ObjectEditState, ObjectEditWorkflow } from "../shared/contracts/v1.js";

/**
 * Presentation rules for the object-edit card. Pure so the web and desktop
 * surfaces agree on ordering, labels and which action is currently legal.
 */

export type RiskBand = "low" | "medium" | "high";

export function candidateRisk(candidate: ObjectCandidate): number {
  const risk = candidate.risk;
  const weighted = 0.5 * risk.areaRatio + 0.3 * risk.occlusion + 0.2 * risk.motion;
  const bounded = Math.max(0, Math.min(1, weighted));
  return risk.overlapProtected ? Math.max(bounded, 0.95) : bounded;
}

export function riskBand(candidate: ObjectCandidate): RiskBand {
  const score = candidateRisk(candidate);
  if (score >= 0.65) return "high";
  if (score >= 0.35) return "medium";
  return "low";
}

const ROLE_ORDER: Record<ObjectCandidate["role"], number> = {
  protagonist: 0,
  uncertain: 1,
  background: 2,
};

/** Protagonist first, then uncertain, then background; risk breaks ties. */
export function rankCandidates(candidates: readonly ObjectCandidate[]): ObjectCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
      candidateRisk(right) - candidateRisk(left) ||
      left.objectId.localeCompare(right.objectId),
  );
}

export const ROLE_LABELS: Record<ObjectCandidate["role"], string> = {
  protagonist: "主角",
  uncertain: "待确认",
  background: "背景",
};

export interface StateCopy {
  label: string;
  hint: string;
  tone: "info" | "action" | "done" | "error";
}

export function describeObjectEditState(state: ObjectEditState): StateCopy {
  switch (state) {
    case "analyzing":
      return {
        label: "分析中",
        hint: "本机正在检测人物，结果回来后在这里选择要移除的人。",
        tone: "info",
      };
    case "awaiting_target_selection":
      return {
        label: "选择目标",
        hint: "确认每一帧里谁是你要去掉的人；不确定的候选不会被自动当成主角。",
        tone: "action",
      };
    case "awaiting_mask_review":
      return {
        label: "掩码待审",
        hint: "检查叠色掩码是否完整覆盖目标，再批准或拒绝。",
        tone: "action",
      };
    case "awaiting_generation_review":
      return {
        label: "去人待验收",
        hint: "生成完成后由本机回报残留、完整与闪烁指标。",
        tone: "action",
      };
    case "completed":
      return { label: "已完成", hint: "目标已移除并通过全部质量阈值。", tone: "done" };
    case "failed":
      return {
        label: "未通过",
        hint: "质量阈值未满足，可换掩码或重新选择目标。",
        tone: "error",
      };
    default:
      return { label: state, hint: "", tone: "info" };
  }
}

/** Decisions the user already recorded, keyed by object id. */
export function decisionsById(
  workflow: ObjectEditWorkflow,
): Map<string, "remove" | "keep" | "skip"> {
  return new Map(workflow.decisions.map((decision) => [decision.objectId, decision.decision]));
}

export function removeCount(workflow: ObjectEditWorkflow): number {
  return workflow.decisions.filter((decision) => decision.decision === "remove").length;
}
