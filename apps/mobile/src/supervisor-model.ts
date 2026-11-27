import {
  AveClient,
  downloadArtifactBytes,
  sha256HexBrowserSafe,
  type WebSocketConstructor,
} from "@ave/client-sdk";
import type {
  ApprovalRequest,
  EditorEvent,
  EditorPrincipal,
  JobSnapshot,
  ProjectSnapshot,
} from "@ave/contracts";

/**
 * Capability boundary of the Expo Android remote supervisor: timeline editing and
 * mask refinement stay exclusively desktop-side; mobile focuses on preview,
 * human approvals, job cancellation, and verified downloads.
 */
export const MOBILE_SUPERVISOR_CAPABILITIES = {
  timelineEditing: false,
  maskRefinement: false,
  preview: true,
  approvals: true,
  cancelJob: true,
  verifiedDownload: true,
} as const;

export interface PairedDeviceCredential {
  deviceId: string;
  credential: string;
}

export interface MobilePairingConnectOptions {
  url: string;
  ownerToken?: string;
  invitation?: { invitationId: string; token: string };
  device?: PairedDeviceCredential;
  WebSocketImpl?: WebSocketConstructor;
  reconnect?: boolean;
}

/**
 * Typed remote supervision controller for Android (`@ave/mobile`), built
 * strictly on `@ave/client-sdk` and `@ave/contracts`.
 */
export class MobileSupervisorSession {
  readonly capabilities = MOBILE_SUPERVISOR_CAPABILITIES;

  private constructor(
    readonly client: AveClient,
    readonly principal: EditorPrincipal,
    readonly credential?: PairedDeviceCredential,
  ) {}

  static async pairAndConnect(
    options: MobilePairingConnectOptions,
  ): Promise<MobileSupervisorSession> {
    if (options.device) {
      const client = new AveClient({
        url: options.url,
        auth: {
          kind: "device",
          deviceId: options.device.deviceId,
          credential: options.device.credential,
        },
        WebSocketImpl: options.WebSocketImpl,
        reconnect: options.reconnect ?? true,
      });
      const principal = await client.connect();
      return new MobileSupervisorSession(client, principal, options.device);
    }

    if (options.invitation && options.ownerToken) {
      const pairingClient = new AveClient({
        url: options.url,
        auth: { kind: "localOwner", token: options.ownerToken },
        WebSocketImpl: options.WebSocketImpl,
        reconnect: false,
      });
      try {
        await pairingClient.connect();
        const redeemed = await pairingClient.call<{
          deviceId: string;
          credential: string;
          principal: EditorPrincipal;
        }>("video.v1.redeem_invitation", options.invitation);
        const deviceClient = new AveClient({
          url: options.url,
          auth: {
            kind: "device",
            deviceId: redeemed.deviceId,
            credential: redeemed.credential,
          },
          WebSocketImpl: options.WebSocketImpl,
          reconnect: options.reconnect ?? true,
        });
        const principal = await deviceClient.connect();
        return new MobileSupervisorSession(deviceClient, principal, {
          deviceId: redeemed.deviceId,
          credential: redeemed.credential,
        });
      } finally {
        pairingClient.close();
      }
    }

    if (options.ownerToken) {
      const ownerClient = new AveClient({
        url: options.url,
        auth: { kind: "localOwner", token: options.ownerToken },
        WebSocketImpl: options.WebSocketImpl,
        reconnect: options.reconnect ?? true,
      });
      const principal = await ownerClient.connect();
      return new MobileSupervisorSession(ownerClient, principal);
    }

    throw new Error("Provide either paired device credentials, ownerToken + invitation, or ownerToken");
  }

  listProjects() {
    return this.client.listProjects();
  }

  async openProject(
    projectId: string,
    onEvent: (event: EditorEvent) => void,
  ): Promise<{ snapshot: ProjectSnapshot; unsubscribe: () => void }> {
    const snapshot = await this.client.getProject(projectId);
    const unsubscribe = await this.client.subscribe(projectId, snapshot.latestSeq, onEvent);
    return { snapshot, unsubscribe };
  }

  approve(approvalId: string, expectedRevision: string, requestId: string) {
    return this.client.decideApproval({
      requestId,
      approvalId,
      expectedRevision,
      decision: "approve",
    });
  }

  reject(approvalId: string, expectedRevision: string, requestId: string, comment?: string) {
    return this.client.decideApproval({
      requestId,
      approvalId,
      expectedRevision,
      decision: "reject",
      ...(comment ? { comment } : {}),
    });
  }

  revokeApproval(projectId: string, approvalId: string, requestId: string): Promise<ApprovalRequest> {
    return this.client.revokeApproval({ requestId, projectId, approvalId });
  }

  cancelJob(projectId: string, jobId: string, requestId: string): Promise<JobSnapshot> {
    return this.client.controlJob({
      requestId,
      projectId,
      jobId,
      action: "cancel",
    });
  }

  downloadVerifiedArtifact(
    projectId: string,
    assetId: string,
    revision: string,
  ): Promise<{ bytes: Uint8Array; sha256: string }> {
    return downloadArtifactBytes(
      this.client,
      { projectId, assetId, revision },
      sha256HexBrowserSafe,
    );
  }

  close(): void {
    this.client.close();
  }
}
