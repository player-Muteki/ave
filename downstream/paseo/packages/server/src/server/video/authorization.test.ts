import { describe, expect, it } from "vitest";
import { authorizeVideoMethod, editorPrincipalForCaller, type EditorCaller } from "./authorization.js";
import type { EditorPrincipal } from "#video-editor/contracts/v1";

const owner: EditorPrincipal = { principalId: "owner", role: "owner", projectIds: null };
const viewer: EditorPrincipal = { principalId: "viewer-1", role: "viewer", projectIds: ["p1"] };
const operator: EditorPrincipal = { principalId: "operator-1", role: "operator", projectIds: ["p1"] };
const device = (principal: EditorPrincipal): EditorCaller => ({
  principalId: principal.principalId,
  permissions: [],
  editorPrincipal: principal,
});

describe("editorPrincipalForCaller", () => {
  it("prefers an explicit device credential", () => {
    expect(editorPrincipalForCaller(device(viewer))).toEqual(viewer);
  });
  it("maps a daemon.manage owner session to the owner principal", () => {
    expect(
      editorPrincipalForCaller({ principalId: "owner", permissions: ["daemon.manage"] }),
    ).toEqual(owner);
  });
  it("rejects a session without a video credential", () => {
    expect(() => editorPrincipalForCaller({ principalId: "someone", permissions: [] })).toThrow(
      "no video editor credential",
    );
  });
});

describe("authorizeVideoMethod role matrix", () => {
  it("rejects non-video methods", () => {
    expect(() => authorizeVideoMethod("daemon.v1.shutdown", device(owner))).toThrow(
      "Unknown video editor operation",
    );
  });
  it("owner may call management methods", () => {
    expect(authorizeVideoMethod("video.v1.create_invitation", device(owner))).toEqual(owner);
    expect(authorizeVideoMethod("video.v1.import_asset", device(owner))).toEqual(owner);
  });
  it("viewer may read, including the new list_projects and review chunks", () => {
    for (const method of [
      "video.v1.get_capabilities",
      "video.v1.list_projects",
      "video.v1.get_project",
      "video.v1.get_job",
      "video.v1.get_events",
      "video.v1.read_asset_chunk",
    ]) {
      expect(authorizeVideoMethod(method, device(viewer))).toEqual(viewer);
    }
  });
  it("viewer cannot modify or manage", () => {
    for (const method of ["video.v1.submit_plan", "video.v1.create_job", "video.v1.control_job"]) {
      expect(() => authorizeVideoMethod(method, device(viewer))).toThrow("viewer cannot modify");
    }
    expect(() => authorizeVideoMethod("video.v1.create_invitation", device(viewer))).toThrow(
      "Only the project owner",
    );
    expect(() => authorizeVideoMethod("video.v1.redeem_invitation", device(viewer))).toThrow(
      "Only the project owner",
    );
  });
  it("operator may edit and control jobs but not manage devices or imports", () => {
    for (const method of [
      "video.v1.get_project",
      "video.v1.submit_plan",
      "video.v1.create_job",
      "video.v1.decide_approval",
      "video.v1.control_job",
    ]) {
      expect(authorizeVideoMethod(method, device(operator))).toEqual(operator);
    }
    for (const method of ["video.v1.create_invitation", "video.v1.redeem_invitation", "video.v1.configure_worker", "video.v1.import_asset"]) {
      expect(() => authorizeVideoMethod(method, device(operator))).toThrow("Only the project owner");
    }
  });
  it("operator cannot revoke device credentials", () => {
    // revoke_device is a management method, so the owner-only gate fires first.
    expect(() => authorizeVideoMethod("video.v1.revoke_device", device(operator))).toThrow(
      "Only the project owner",
    );
  });
});