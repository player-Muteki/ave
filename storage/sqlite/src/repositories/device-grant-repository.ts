import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { editorFailure, type EditorPrincipal, type EditorRole } from "@ave/contracts";
import { assertRoleAtLeast } from "@ave/domain";
import type { TransactionCoordinator } from "../coordinator.js";

function tokenHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function sameSecret(expectedHex: string, candidate: string): boolean {
  const actual = Buffer.from(tokenHash(candidate), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface ProjectRow {
  project_id: string;
  title: string;
  revision: string;
  asset_manifest_hash: string;
}

export class DeviceGrantRepository {
  private readonly revokeListeners = new Set<(deviceId: string) => void>();

  constructor(private readonly tx: TransactionCoordinator) {}

  createInvitation(input: {
    role: Exclude<EditorRole, "owner">;
    projectIds: string[];
    ttlSeconds?: number;
  }): { invitationId: string; token: string; expiresAt: string } {
    if (input.projectIds.length === 0) {
      editorFailure("INVALID_ARGUMENT", "An invitation must be scoped to at least one project");
    }
    const invitationId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + (input.ttlSeconds ?? 600) * 1000).toISOString();
    this.tx.db
      .prepare(
        "INSERT INTO invitations(invitation_id, token_hash, role, project_ids, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
      )
      .run(
        invitationId,
        tokenHash(token),
        input.role,
        JSON.stringify(input.projectIds),
        expiresAt,
        this.tx.now(),
      );
    return { invitationId, token, expiresAt };
  }

  redeemInvitation(
    invitationId: string,
    token: string,
  ): { deviceId: string; credential: string; principal: EditorPrincipal } {
    return this.tx.runInTransaction(() => {
      const invitation = this.tx.db
        .prepare(
          "SELECT invitation_id, token_hash, role, project_ids, expires_at, used_at FROM invitations WHERE invitation_id = ?",
        )
        .get(invitationId) as
        | {
            invitation_id: string;
            token_hash: string;
            role: EditorRole;
            project_ids: string;
            expires_at: string;
            used_at: string | null;
          }
        | undefined;

      if (
        !invitation ||
        invitation.used_at ||
        Date.parse(invitation.expires_at) <= Date.now() ||
        !sameSecret(invitation.token_hash, token)
      ) {
        editorFailure(
          "UNAUTHENTICATED",
          "The pairing invitation is invalid, expired or already used",
        );
      }

      const projectIds = JSON.parse(invitation.project_ids) as string[];
      const deviceId = randomUUID();
      const credential = randomBytes(32).toString("base64url");
      const now = this.tx.now();

      this.tx.db
        .prepare("UPDATE invitations SET used_at = ? WHERE invitation_id = ?")
        .run(now, invitationId);
      this.tx.db
        .prepare(
          "INSERT INTO devices(device_id, token_hash, role, project_ids, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
        )
        .run(deviceId, tokenHash(credential), invitation.role, JSON.stringify(projectIds), now);

      for (const projectId of projectIds) {
        const exists = this.tx.db
          .prepare("SELECT 1 FROM projects WHERE project_id = ?")
          .get(projectId);
        if (exists) {
          this.grantProjectRole(projectId, deviceId, invitation.role);
        }
      }

      return {
        deviceId,
        credential,
        principal: { principalId: deviceId, role: invitation.role, projectIds },
      };
    });
  }

  authenticate(deviceId: string, credential: string): EditorPrincipal {
    const device = this.tx.db
      .prepare("SELECT device_id, token_hash, role, project_ids, revoked_at FROM devices WHERE device_id = ?")
      .get(deviceId) as
      | {
          device_id: string;
          token_hash: string;
          role: EditorRole;
          project_ids: string | null;
          revoked_at: string | null;
        }
      | undefined;

    if (!device || device.revoked_at || !sameSecret(device.token_hash, credential)) {
      editorFailure("UNAUTHENTICATED", "The device credential is invalid or revoked");
    }
    return this.activePrincipal(deviceId);
  }

  activePrincipal(deviceId: string): EditorPrincipal {
    const device = this.tx.db
      .prepare("SELECT device_id, role, project_ids, revoked_at FROM devices WHERE device_id = ?")
      .get(deviceId) as
      | {
          device_id: string;
          role: EditorRole;
          project_ids: string | null;
          revoked_at: string | null;
        }
      | undefined;

    const projectIds = device?.project_ids ? (JSON.parse(device.project_ids) as string[]) : null;
    if (!device || device.revoked_at || device.role === "owner" || !projectIds?.length) {
      editorFailure("UNAUTHENTICATED", "The device is not active");
    }
    return { principalId: deviceId, role: device.role, projectIds };
  }

  revokeDevice(deviceId: string): void {
    const row = this.tx.db
      .prepare("SELECT device_id, revoked_at FROM devices WHERE device_id = ?")
      .get(deviceId) as { device_id: string; revoked_at: string | null } | undefined;
    if (!row) {
      editorFailure("ASSET_NOT_FOUND", "Unknown video editor device");
    }
    if (!row.revoked_at) {
      this.tx.db
        .prepare("UPDATE devices SET revoked_at = ? WHERE device_id = ?")
        .run(this.tx.now(), deviceId);
    }
    for (const listener of this.revokeListeners) listener(deviceId);
  }

  onRevoke(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  grantProjectRole(projectId: string, principalId: string, role: EditorRole): void {
    this.tx.db
      .prepare(
        "INSERT INTO project_grants(project_id, principal_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role",
      )
      .run(projectId, principalId, role);
  }

  registerDevice(input: {
    projectId: string;
    principalId: string;
    role: EditorRole;
    actor: EditorPrincipal;
  }): void {
    this.authorizeProject(input.projectId, input.actor, "owner");
    this.grantProjectRole(input.projectId, input.principalId, input.role);
  }

  registerPrincipal(projectId: string, principal: EditorPrincipal): void {
    this.authorizeProject(projectId, { principalId: "owner", role: "owner", projectIds: null }, "owner");
    this.grantProjectRole(projectId, principal.principalId, principal.role);
  }

  requireProjectRow(projectId: string): ProjectRow {
    const row = this.tx.db
      .prepare(
        "SELECT project_id, title, revision, asset_manifest_hash FROM projects WHERE project_id = ?",
      )
      .get(projectId) as ProjectRow | undefined;
    if (!row) editorFailure("PROJECT_NOT_FOUND", "The project does not exist");
    return row;
  }

  authorizeProject(projectId: string, principal: EditorPrincipal, required: EditorRole): void {
    if (principal.projectIds !== null && !principal.projectIds.includes(projectId)) {
      editorFailure("PERMISSION_DENIED", "The credential has no access to this project");
    }
    assertRoleAtLeast(principal, required);
    if (principal.role !== "owner") {
      const row = this.tx.db
        .prepare("SELECT role FROM project_grants WHERE project_id = ? AND principal_id = ?")
        .get(projectId, principal.principalId) as { role: EditorRole } | undefined;
      if (!row) {
        editorFailure("PERMISSION_DENIED", "The device has no grant for this project");
      }
      assertRoleAtLeast({ ...principal, role: row.role }, required);
    }
    this.requireProjectRow(projectId);
  }
}
