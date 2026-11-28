import { describe, expect, it, vi } from "vitest";
import { EditorError } from "@ave/contracts";
import { MANAGE_METHODS, READ_METHODS } from "@ave/domain";
import { AveRpcRegistry, type AveRpcDependencies } from "../src/rpc-registry.js";

const HASH = "a".repeat(64);

const viewer = { principalId: "v", role: "viewer" as const, projectIds: ["p1"] };
const operator = { principalId: "o", role: "operator" as const, projectIds: ["p1"] };
const owner = { principalId: "owner", role: "owner" as const, projectIds: null };

function caller(editorPrincipal?: typeof viewer | typeof operator | typeof owner) {
  return editorPrincipal
    ? { principalId: editorPrincipal.principalId, editorPrincipal }
    : { principalId: "anonymous" };
}

async function expectFailure(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(EditorError);
  await promise.catch((error: EditorError) => expect(error.code).toBe(code));
}

function build(overrides: Partial<AveRpcDependencies> = {}) {
  const snapshot = {
    projectId: "p1",
    revision: "0",
    title: "Project",
    baseAssetManifestHash: HASH,
    assets: [],
    plans: [],
    approvals: [],
    jobs: [],
  };
  const getProjectSnapshot = vi.fn(() => snapshot);
  const listProjects = vi.fn(() => [{ projectId: "p1", title: "Project" }]);
  const createPlan = vi.fn(() => ({ plan: { projectId: "p1", planId: "plan-1" } }));
  const createProject = vi.fn(() => snapshot);
  const revokeDevice = vi.fn(() => ({ revoked: true }));
  const createInvitation = vi.fn(() => ({ invitationId: "inv-1", token: "tok" }));
  const contactSheet = vi.fn(async () => ({ frames: 0 }));
  const capabilities = vi.fn(async () => ({ posters: true }));
  const burnInSubtitlesAvailable = vi.fn(async () => false);
  const writeUploadChunk = vi.fn(async () => "262144");
  const enqueue = vi.fn();

  const deps: AveRpcDependencies = {
    store: {
      projects: { getProjectSnapshot, listProjects, createProject },
      plans: { createPlan },
      devices: { revokeDevice, createInvitation },
      jobs: {},
      objectEdits: {},
    } as unknown as AveRpcDependencies["store"],
    cas: {} as AveRpcDependencies["cas"],
    backends: {
      get: () => ({ burnInSubtitlesAvailable, contactSheet }),
      capabilities,
    } as unknown as AveRpcDependencies["backends"],
    jobs: { enqueue, control: vi.fn() } as unknown as AveRpcDependencies["jobs"],
    uploads: {
      writeUploadChunk,
      cancelUpload: vi.fn(async () => ({})),
      commitUpload: vi.fn(async () => ({})),
    } as unknown as AveRpcDependencies["uploads"],
    queries: {} as DaemonQueries,
    onProjectEvent: vi.fn(),
    ...overrides,
  };

  return {
    registry: new AveRpcRegistry(deps),
    spies: {
      getProjectSnapshot,
      listProjects,
      createPlan,
      createProject,
      revokeDevice,
      createInvitation,
      contactSheet,
      capabilities,
      burnInSubtitlesAvailable,
      writeUploadChunk,
      enqueue,
    },
  };
}

type DaemonQueries = AveRpcDependencies["queries"];

describe("AveRpcRegistry authorization boundary", () => {
  it("registers exactly the frozen 63-method surface and covers every read method", () => {
    const { registry } = build();
    const methods = registry.listRegisteredMethods();
    expect(methods).toHaveLength(63);
    expect(methods).toEqual([...methods].sort());
    for (const method of READ_METHODS) expect(methods).toContain(method);
  });

  it("denies an unauthenticated caller before any handler runs", async () => {
    const { registry, spies } = build();
    await expectFailure(registry.invoke("video.v1.get_project", { projectId: "p1" }, caller()), "UNAUTHENTICATED");
    expect(spies.getProjectSnapshot).not.toHaveBeenCalled();
  });

  it("denies a non-video namespace even for the owner", async () => {
    const { registry } = build();
    await expectFailure(registry.invoke("fs.read_file", {}, caller(owner)), "PERMISSION_DENIED");
  });

  it("lets a viewer read but blocks a viewer write", async () => {
    const { registry, spies } = build();
    await expect(registry.invoke("video.v1.get_project", { projectId: "p1" }, caller(viewer))).resolves.toMatchObject({
      projectId: "p1",
    });
    expect(spies.getProjectSnapshot).toHaveBeenCalledTimes(1);

    await expectFailure(registry.invoke("video.v1.contact_sheet", {}, caller(viewer)), "PERMISSION_DENIED");
    expect(spies.contactSheet).not.toHaveBeenCalled();
  });

  it("blocks operator from manage methods and from revoking devices", async () => {
    const { registry, spies } = build();
    await expectFailure(
      registry.invoke("video.v1.create_invitation", { role: "viewer", projectIds: ["p1"] }, caller(operator)),
      "PERMISSION_DENIED",
    );
    await expectFailure(registry.invoke("video.v1.revoke_device", { deviceId: "d1" }, caller(operator)), "PERMISSION_DENIED");
    expect(spies.createInvitation).not.toHaveBeenCalled();
    expect(spies.revokeDevice).not.toHaveBeenCalled();
  });

  it("allows the owner through the same manage methods", async () => {
    const { registry, spies } = build();
    await expect(
      registry.invoke("video.v1.revoke_device", { deviceId: "d1" }, caller(owner)),
    ).resolves.toEqual({ deviceId: "d1", revoked: true });
    expect(spies.revokeDevice).toHaveBeenCalledWith("d1");
  });

  it("rejects a write payload before touching storage", async () => {
    const { registry, spies } = build();
    await expectFailure(registry.invoke("video.v1.get_project", { projectId: 42 }, caller(owner)), "INVALID_ARGUMENT");
    expect(spies.getProjectSnapshot).not.toHaveBeenCalled();
  });

  it("reports CAPABILITY_UNAVAILABLE for an unregistered method after authorization", async () => {
    const { registry } = build();
    await expectFailure(registry.invoke("video.v1.configure_worker", { workerId: "w1" }, caller(owner)), "CAPABILITY_UNAVAILABLE");
  });

  it("keeps direct filesystem import closed for the owner", async () => {
    const { registry } = build();
    await expectFailure(registry.invoke("video.v1.import_asset", {}, caller(owner)), "PERMISSION_DENIED");
  });

  it("fails closed when the media worker is absent", async () => {
    const { registry } = build();
    const request = {
      projectId: "p1",
      assetId: "a1",
      streamUid: "s0",
      sourcePresentationIndexHash: HASH,
      frame: 0,
      points: [],
    };
    await expectFailure(registry.invoke("video.v1.inspect_frame", request, caller(owner)), "CAPABILITY_UNAVAILABLE");
  });

  it("rejects non-binary upload chunks", async () => {
    const { registry, spies } = build();
    await expectFailure(registry.invoke("video.v1.write_upload_chunk", { hello: 1 }, caller(owner)), "INVALID_ARGUMENT");
    expect(spies.writeUploadChunk).not.toHaveBeenCalled();
  });

  it("advertises optional capabilities only when they are attached", async () => {
    const plain = build();
    const plainFeatures = (await plain.registry.invoke("video.v1.get_capabilities", {}, caller(owner))) as {
      features: string[];
      operations: string[];
    };
    expect(plainFeatures.features).not.toContain("native-planner");
    expect(plainFeatures.features).not.toContain("mask-tracking");
    expect(plainFeatures.operations).toHaveLength(63);

    const attached = build({
      mediaWorker: {
        hasMaskTracking: () => true,
        hasVace: () => false,
      } as unknown as AveRpcDependencies["mediaWorker"],
    });
    attached.registry.attachPlanner({
      startRun: vi.fn(),
      steerRun: vi.fn(),
      followUpRun: vi.fn(),
      stopRun: vi.fn(),
      status: vi.fn(),
    } as unknown as NonNullable<AveRpcDependencies["planner"]>);
    const features = ((await attached.registry.invoke("video.v1.get_capabilities", {}, caller(owner))) as {
      features: string[];
    }).features;
    expect(features).toContain("native-planner");
    expect(features).toContain("mask-tracking");
    expect(features).not.toContain("vace-preview");
  });
});

describe("authorization matrix consistency", () => {
  it("keeps read and manage sets disjoint", () => {
    for (const method of READ_METHODS) expect(MANAGE_METHODS.has(method)).toBe(false);
  });

  // configure_worker stays in the frozen MANAGE_METHODS matrix but has no native
  // handler. Non-owners are denied, owners reach CAPABILITY_UNAVAILABLE above.
  it("documents the unregistered manage entry", () => {
    const { registry } = build();
    expect(MANAGE_METHODS.has("video.v1.configure_worker")).toBe(true);
    expect(registry.listRegisteredMethods()).not.toContain("video.v1.configure_worker");
  });
});
