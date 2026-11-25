import type { DaemonPermission } from "../authorization/index.js";
import type { EditorPrincipal } from "#video-editor/contracts/v1";
import { editorFailure } from "./errors.js";

export interface EditorCaller {
  principalId: string;
  permissions: readonly DaemonPermission[];
  editorPrincipal?: EditorPrincipal;
}

const READ_METHODS = new Set([
  "video.v1.get_capabilities",
  "video.v1.list_projects",
  "video.v1.get_project",
  "video.v1.get_job",
  "video.v1.get_events",
  "video.v1.get_upload_status",
  "video.v1.get_planning_run",
  // Watching a reviewable proxy/candidate is a read; the store still enforces project scope,
  // candidate revision and the awaiting-review state, and only delivered bytes are exportable.
  "video.v1.read_asset_chunk",
]);
const MANAGE_METHODS = new Set([
  "video.v1.create_invitation",
  "video.v1.redeem_invitation",
  "video.v1.revoke_device",
  "video.v1.configure_worker",
  "video.v1.import_asset",
]);

export function editorPrincipalForCaller(caller: EditorCaller): EditorPrincipal {
  if (caller.editorPrincipal) return caller.editorPrincipal;
  if (caller.principalId === "owner" && caller.permissions.includes("daemon.manage")) {
    return { principalId: "owner", role: "owner", projectIds: null };
  }
  editorFailure("UNAUTHENTICATED", "The session has no video editor credential");
}

export function authorizeVideoMethod(method: string, caller: EditorCaller): EditorPrincipal {
  if (!method.startsWith("video.v1."))
    editorFailure("PERMISSION_DENIED", "Unknown video editor operation");
  const principal = editorPrincipalForCaller(caller);
  if (principal.role === "owner") return principal;
  if (MANAGE_METHODS.has(method))
    editorFailure(
      "PERMISSION_DENIED",
      "Only the project owner can manage video devices or imports",
    );
  if (principal.role === "viewer" && !READ_METHODS.has(method)) {
    editorFailure("PERMISSION_DENIED", "A viewer cannot modify this video project");
  }
  if (principal.role === "operator" && method === "video.v1.revoke_device") {
    editorFailure("PERMISSION_DENIED", "An operator cannot revoke device credentials");
  }
  return principal;
}
