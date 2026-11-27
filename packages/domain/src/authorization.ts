import { editorFailure, type EditorPrincipal, type EditorRole } from "@ave/contracts";

export interface AveCaller {
  principalId: string;
  editorPrincipal?: EditorPrincipal;
  isLocalOwner?: boolean;
}

export const READ_METHODS = new Set([
  "video.v1.get_capabilities",
  "video.v1.list_projects",
  "video.v1.get_project",
  "video.v1.get_mask_revision",
  "video.v1.get_job",
  "video.v1.get_events",
  "video.v1.get_run_events",
  "video.v1.list_approvals",
  "video.v1.list_plans",
  "video.v1.get_run_questions",
  "video.v1.get_model_policies",
  "video.v1.get_upload_status",
  "video.v1.get_planning_run",
  "video.v1.get_analysis",
  "video.v1.get_qa_summary",
  "video.v1.get_scene_cuts",
  "video.v1.get_waveform",
  "video.v1.get_plan",
  "video.v1.list_artifacts",
  "video.v1.get_export_summary",
  "video.v1.get_asset_metadata",
  "video.v1.get_approval",
  "video.v1.get_object_edit",
  "video.v1.list_object_edits",
  "video.v1.get_mutation_result",
  "video.v1.read_asset_chunk",
]);

export const MANAGE_METHODS = new Set([
  "video.v1.create_invitation",
  "video.v1.redeem_invitation",
  "video.v1.revoke_device",
  "video.v1.configure_worker",
  "video.v1.import_asset",
  "video.v1.record_object_candidates",
  "video.v1.record_object_qa",
]);

const ROLE_RANK: Record<EditorRole, number> = {
  viewer: 0,
  operator: 1,
  owner: 2,
};

export function assertRoleAtLeast(principal: EditorPrincipal, required: EditorRole): void {
  if (ROLE_RANK[principal.role] < ROLE_RANK[required]) {
    editorFailure("PERMISSION_DENIED", `This operation requires ${required} access`);
  }
}

export function editorPrincipalForCaller(caller: AveCaller): EditorPrincipal {
  if (caller.editorPrincipal) return caller.editorPrincipal;
  if (caller.principalId === "owner" && caller.isLocalOwner) {
    return { principalId: "owner", role: "owner", projectIds: null };
  }
  editorFailure("UNAUTHENTICATED", "The session has no video editor credential");
}

export function authorizeVideoMethod(method: string, caller: AveCaller): EditorPrincipal {
  if (!method.startsWith("video.v1.")) {
    editorFailure("PERMISSION_DENIED", "Unknown video editor operation");
  }
  const principal = editorPrincipalForCaller(caller);
  if (principal.role === "owner") return principal;
  if (MANAGE_METHODS.has(method)) {
    editorFailure("PERMISSION_DENIED", "Only the project owner can manage video devices or imports");
  }
  if (principal.role === "viewer" && !READ_METHODS.has(method)) {
    editorFailure("PERMISSION_DENIED", "A viewer cannot modify this video project");
  }
  if (principal.role === "operator" && method === "video.v1.revoke_device") {
    editorFailure("PERMISSION_DENIED", "An operator cannot revoke device credentials");
  }
  return principal;
}
