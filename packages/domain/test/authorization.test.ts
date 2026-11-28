import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AveCaller } from "../src/authorization.js";
import {
  MANAGE_METHODS,
  READ_METHODS,
  assertRoleAtLeast,
  authorizeVideoMethod,
  editorPrincipalForCaller,
} from "../src/authorization.js";

const R0_SPEC = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../../conformance/r0-baseline/baseline-spec.json"), "utf8"),
) as {
  rpcSurface: {
    mainSwitchMethods: string[];
    disabledStubs: string[];
    deviceOnlyMethods: string[];
    authorizationMatrix: {
      readMethods: string[];
      manageMethods: string[];
      operatorExtraForbidden: string[];
    };
  };
};

const ALL_METHODS = [
  ...R0_SPEC.rpcSurface.mainSwitchMethods,
  ...R0_SPEC.rpcSurface.disabledStubs,
  ...R0_SPEC.rpcSurface.deviceOnlyMethods,
];

const caller = (role: "viewer" | "operator" | "owner"): AveCaller => ({
  principalId: role,
  editorPrincipal: { principalId: role, role, projectIds: null },
});
const anon: AveCaller = { principalId: "anon" };
const localOwner: AveCaller = { principalId: "owner", isLocalOwner: true };

/** Run fn and return the EditorError code, or null if it did not throw. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe("@ave/domain authorization boundary", () => {
  it("read and manage sets are disjoint and match the frozen R0 matrix", () => {
    expect([...READ_METHODS].sort()).toEqual([...R0_SPEC.rpcSurface.authorizationMatrix.readMethods].sort());
    expect([...MANAGE_METHODS].sort()).toEqual([...R0_SPEC.rpcSurface.authorizationMatrix.manageMethods].sort());
    expect([...READ_METHODS].filter((m) => MANAGE_METHODS.has(m))).toEqual([]);
  });

  it("every registered method is classified exactly once by role (exhaustive matrix)", () => {
    expect(ALL_METHODS.length).toBeGreaterThan(60);
    for (const method of ALL_METHODS) {
      expect(method.startsWith("video.v1.")).toBe(true);
      // unauthenticated caller is always rejected
      expect(codeOf(() => authorizeVideoMethod(method, anon))).toBe("UNAUTHENTICATED");
      // owner can do everything
      expect(authorizeVideoMethod(method, caller("owner")).role).toBe("owner");
      // viewer: only read methods
      const viewerAllowed = READ_METHODS.has(method);
      if (viewerAllowed) {
        expect(authorizeVideoMethod(method, caller("viewer")).role).toBe("viewer");
      } else {
        expect(codeOf(() => authorizeVideoMethod(method, caller("viewer")))).toBe("PERMISSION_DENIED");
      }
      // operator: everything except manage methods and the operator-extra-forbidden list
      const operatorForbidden =
        MANAGE_METHODS.has(method) || R0_SPEC.rpcSurface.authorizationMatrix.operatorExtraForbidden.includes(method);
      if (operatorForbidden) {
        expect(codeOf(() => authorizeVideoMethod(method, caller("operator")))).toBe("PERMISSION_DENIED");
      } else {
        expect(authorizeVideoMethod(method, caller("operator")).role).toBe("operator");
      }
    }
  });

  it("rejects non video.v1 methods before any role check", () => {
    expect(codeOf(() => authorizeVideoMethod("fs.readFile", caller("owner")))).toBe("PERMISSION_DENIED");
    expect(codeOf(() => authorizeVideoMethod("video.v2.get_project", caller("owner")))).toBe("PERMISSION_DENIED");
    expect(codeOf(() => authorizeVideoMethod("", caller("owner")))).toBe("PERMISSION_DENIED");
  });

  it("resolves principals from the caller credential, not from user input", () => {
    // owner principalId without the local-owner flag must not authenticate
    expect(codeOf(() => editorPrincipalForCaller({ principalId: "owner" }))).toBe("UNAUTHENTICATED");
    expect(editorPrincipalForCaller(localOwner)).toEqual({ principalId: "owner", role: "owner", projectIds: null });
    // an explicit editorPrincipal is trusted as the session credential
    expect(editorPrincipalForCaller(caller("viewer")).role).toBe("viewer");
  });

  it("assertRoleAtLeast enforces the viewer < operator < owner ranking", () => {
    const viewer = caller("viewer").editorPrincipal!;
    const operator = caller("operator").editorPrincipal!;
    const owner = caller("owner").editorPrincipal!;
    expect(codeOf(() => assertRoleAtLeast(viewer, "viewer"))).toBeNull();
    expect(codeOf(() => assertRoleAtLeast(viewer, "operator"))).toBe("PERMISSION_DENIED");
    expect(codeOf(() => assertRoleAtLeast(operator, "operator"))).toBeNull();
    expect(codeOf(() => assertRoleAtLeast(operator, "owner"))).toBe("PERMISSION_DENIED");
    expect(codeOf(() => assertRoleAtLeast(owner, "owner"))).toBeNull();
  });
});
