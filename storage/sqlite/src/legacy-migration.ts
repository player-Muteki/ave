import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { ContentAddressedStore, sha256File } from "@ave/cas";
import { editorFailure, type BlobRef } from "@ave/contracts";
import { AVE_SQLITE_SCHEMA } from "./schema.js";

export const MIGRATION_SCHEMA_VERSION = "ave.migration/v1" as const;

interface ReadonlySqlite {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

const DatabaseSyncReadonly = NodeDatabaseSync as unknown as new (
  location: string,
  options?: { readOnly?: boolean },
) => ReadonlySqlite;

interface LegacyAccessDocument {
  version: number;
  devices?: Array<{
    deviceId: string;
    tokenHash: string;
    role: string;
    projectIds: string[] | null;
    revokedAt?: string;
    createdAt?: string;
  }>;
}

export interface MigrationManifest {
  schemaVersion: typeof MIGRATION_SCHEMA_VERSION;
  exportedAt: string;
  sourceRoot: string;
  projects: Array<{
    project_id: string;
    title: string;
    revision: string;
    asset_manifest_hash: string;
    created_at: string;
  }>;
  project_grants: Array<{ project_id: string; principal_id: string; role: string }>;
  devices: Array<{
    device_id: string;
    token_hash: string;
    role: string;
    project_ids: string | null;
    revoked_at: string | null;
    created_at: string;
  }>;
  assets: Array<{ asset_id: string; project_id: string; revision: string; document: string }>;
  plans: Array<{
    plan_id: string;
    project_id: string;
    plan_hash: string;
    revision: string;
    document: string;
  }>;
  approvals: Array<{
    approval_id: string;
    project_id: string;
    plan_hash: string;
    purpose: string;
    request: string;
    grant: string | null;
    created_at: string;
  }>;
  mutations: Array<{
    project_id: string;
    request_id: string;
    fingerprint: string;
    response: string;
    created_at: string;
  }>;
  jobs: Array<{
    job_id: string;
    project_id: string;
    plan_hash: string;
    revision: string;
    kind: string;
    document: string;
    active: number;
  }>;
  mask_tracking_jobs: Array<{ job_id: string; project_id: string; request: string }>;
  tracked_mask_reviews: Array<{
    approval_id: string;
    job_id: string;
    decided_by: string | null;
  }>;
  mask_anchors: Array<{
    mask_revision_id: string;
    project_id: string;
    approval_id: string;
    request_id: string;
    request_hash: string;
    document: string;
    approved_by: string | null;
  }>;
  object_edits: Array<{
    workflow_id: string;
    project_id: string;
    asset_id: string;
    document: string;
  }>;
  constant_rate_streams: Array<{ index_sha: string; stream_uid: string }>;
  preview_sheets: Array<{
    artifact_id: string;
    project_id: string;
    job_id: string;
    revision: string;
    blob: string;
  }>;
  contact_sheets: Array<{
    project_id: string;
    revision: string;
    artifact_id: string;
    blob: string;
  }>;
  artifacts: Array<{ artifact_id: string; job_id: string; document: string }>;
  events: Array<{ project_id: string; seq: string; document: string }>;
  outbox: Array<{ event_id: string; project_id: string; seq: string; document: string }>;
  model_policies: Array<{
    project_id: string;
    provider: string;
    model_id: string;
    document: string;
  }>;
  project_settings: Array<{ project_id: string; document: string }>;
  blobs: BlobRef[];
}

function collectBlobRefs(value: unknown, out: Map<string, BlobRef>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectBlobRefs(item, out);
    return;
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(rec.sha256) &&
    typeof rec.bytes === "string" &&
    /^(0|[1-9][0-9]*)$/.test(rec.bytes) &&
    typeof rec.mediaType === "string"
  ) {
    out.set(rec.sha256, {
      sha256: rec.sha256,
      bytes: rec.bytes,
      mediaType: rec.mediaType,
    });
  }
  for (const child of Object.values(rec)) {
    collectBlobRefs(child, out);
  }
}

function casObjectPath(casDir: string, sha256Hex: string): string {
  const flat = path.join(casDir, sha256Hex);
  if (existsSync(flat)) return flat;
  const sharded = path.join(casDir, "blobs", sha256Hex.slice(0, 2), sha256Hex);
  if (existsSync(sharded)) return sharded;
  const objs = path.join(casDir, "objects", sha256Hex.slice(0, 2), sha256Hex);
  if (existsSync(objs)) return objs;
  return sharded;
}

function assertPathsDisjoint(sourceRoot: string, targetRoot: string, label: string): void {
  const src = path.resolve(sourceRoot);
  const dst = path.resolve(targetRoot);
  if (
    src === dst ||
    dst.startsWith(src + path.sep) ||
    src.startsWith(dst + path.sep)
  ) {
    editorFailure(
      "INVALID_ARGUMENT",
      `Target AVE directory cannot overlap ${label} (${src})`,
    );
  }
}

/**
 * Open a legacy Paseo `video-editor` directory strictly read-only, verify all
 * referenced CAS blobs by SHA-256, and export a versioned `ave.migration/v1`
 * manifest suitable for isolated import into native AVE.
 */
export async function exportLegacyProjectManifest(options: {
  legacyRootDir: string;
  outputManifestPath?: string;
  projectIds?: string[];
}): Promise<MigrationManifest> {
  const sourceRoot = path.resolve(options.legacyRootDir);
  const sqlitePath = path.join(sourceRoot, "editor.sqlite");
  if (!existsSync(sqlitePath)) {
    editorFailure("NOT_FOUND", `Legacy database not found at ${sqlitePath}`);
  }
  const casDir = path.join(sourceRoot, "cas");
  const db = new DatabaseSyncReadonly(sqlitePath, { readOnly: true });

  try {
    const tableExists = (name: string) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(name).length > 0;

    const selectAll = <T>(table: string): T[] =>
      tableExists(table) ? (db.prepare(`SELECT * FROM ${table}`).all() as T[]) : [];

    const allProjects = selectAll<MigrationManifest["projects"][number]>("projects");
    const filter = options.projectIds ? new Set(options.projectIds) : null;
    const projects = filter
      ? allProjects.filter((p) => filter.has(p.project_id))
      : allProjects;
    const allowedProjects = new Set(projects.map((p) => p.project_id));

    const filterByProject = <T extends { project_id: string }>(rows: T[]) =>
      filter ? rows.filter((r) => allowedProjects.has(r.project_id)) : rows;

    const project_grants = filterByProject(
      selectAll<MigrationManifest["project_grants"][number]>("project_grants"),
    );
    const assets = filterByProject(selectAll<MigrationManifest["assets"][number]>("assets"));
    const plans = filterByProject(selectAll<MigrationManifest["plans"][number]>("plans"));
    const approvals = filterByProject(
      selectAll<MigrationManifest["approvals"][number]>("approvals"),
    );
    const mutations = filterByProject(
      selectAll<MigrationManifest["mutations"][number]>("mutations"),
    );
    const jobs = filterByProject(selectAll<MigrationManifest["jobs"][number]>("jobs"));
    const allowedJobs = new Set(jobs.map((j) => j.job_id));
    const mask_tracking_jobs = filterByProject(
      selectAll<MigrationManifest["mask_tracking_jobs"][number]>("mask_tracking_jobs"),
    );
    const tracked_mask_reviews = selectAll<MigrationManifest["tracked_mask_reviews"][number]>(
      "tracked_mask_reviews",
    ).filter((r) => !filter || allowedJobs.has(r.job_id));
    const mask_anchors = filterByProject(
      selectAll<MigrationManifest["mask_anchors"][number]>("mask_anchors"),
    );
    const object_edits = filterByProject(
      selectAll<MigrationManifest["object_edits"][number]>("object_edits"),
    );
    const constant_rate_streams = selectAll<MigrationManifest["constant_rate_streams"][number]>(
      "constant_rate_streams",
    );
    const preview_sheets = filterByProject(
      selectAll<MigrationManifest["preview_sheets"][number]>("preview_sheets"),
    );
    const contact_sheets = filterByProject(
      selectAll<MigrationManifest["contact_sheets"][number]>("contact_sheets"),
    );
    const artifacts = selectAll<MigrationManifest["artifacts"][number]>("artifacts").filter(
      (a) => !filter || allowedJobs.has(a.job_id),
    );
    const events = filterByProject(selectAll<MigrationManifest["events"][number]>("events"));
    const outbox = filterByProject(selectAll<MigrationManifest["outbox"][number]>("outbox"));
    const model_policies = filterByProject(
      selectAll<MigrationManifest["model_policies"][number]>("model_policies"),
    );
    const project_settings = filterByProject(
      selectAll<MigrationManifest["project_settings"][number]>("project_settings"),
    );

    const devices: MigrationManifest["devices"] = [];
    const accessPath = path.join(sourceRoot, "access.json");
    if (existsSync(accessPath)) {
      const accessDoc = JSON.parse(await readFile(accessPath, "utf8")) as LegacyAccessDocument;
      for (const dev of accessDoc.devices ?? []) {
        if (dev.revokedAt) continue;
        devices.push({
          device_id: dev.deviceId,
          token_hash: dev.tokenHash,
          role: dev.role,
          project_ids: dev.projectIds ? JSON.stringify(dev.projectIds) : null,
          revoked_at: null,
          created_at: dev.createdAt ?? new Date().toISOString(),
        });
      }
    }

    const blobMap = new Map<string, BlobRef>();
    for (const row of assets) collectBlobRefs(JSON.parse(row.document), blobMap);
    for (const row of jobs) collectBlobRefs(JSON.parse(row.document), blobMap);
    for (const row of artifacts) collectBlobRefs(JSON.parse(row.document), blobMap);
    for (const row of mask_anchors) collectBlobRefs(JSON.parse(row.document), blobMap);
    for (const row of preview_sheets) collectBlobRefs(JSON.parse(row.blob), blobMap);
    for (const row of contact_sheets) collectBlobRefs(JSON.parse(row.blob), blobMap);

    for (const blob of blobMap.values()) {
      const srcFile = casObjectPath(casDir, blob.sha256);
      if (!existsSync(srcFile)) {
        editorFailure("ASSET_NOT_FOUND", `Legacy CAS object missing: ${blob.sha256}`);
      }
      const actual = await sha256File(srcFile);
      if (actual !== blob.sha256) {
        editorFailure(
          "ARTIFACT_HASH_MISMATCH",
          `Legacy CAS object corrupted: ${blob.sha256}`,
        );
      }
    }

    const manifest: MigrationManifest = {
      schemaVersion: MIGRATION_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      sourceRoot,
      projects,
      project_grants,
      devices,
      assets,
      plans,
      approvals,
      mutations,
      jobs,
      mask_tracking_jobs,
      tracked_mask_reviews,
      mask_anchors,
      object_edits,
      constant_rate_streams,
      preview_sheets,
      contact_sheets,
      artifacts,
      events,
      outbox,
      model_policies,
      project_settings,
      blobs: [...blobMap.values()],
    };

    if (options.outputManifestPath) {
      await mkdir(path.dirname(path.resolve(options.outputManifestPath)), { recursive: true });
      await writeFile(options.outputManifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }
    return manifest;
  } finally {
    db.close();
  }
}

export interface ImportMigrationResult {
  projects: number;
  assets: number;
  plans: number;
  approvals: number;
  jobs: number;
  objectEdits: number;
  devices: number;
  blobs: number;
}

/**
 * Import a verified `ave.migration/v1` manifest into a brand-new, isolated
 * native AVE_HOME database and CAS store. Never shares DB or CAS with legacy.
 */
export async function importMigrationManifest(options: {
  manifest: MigrationManifest;
  legacyCasDir: string;
  targetAveHome: string;
}): Promise<ImportMigrationResult> {
  if (options.manifest.schemaVersion !== MIGRATION_SCHEMA_VERSION) {
    editorFailure("SCHEMA_UNSUPPORTED", "Unsupported migration manifest schemaVersion");
  }
  const targetHome = path.resolve(options.targetAveHome);
  assertPathsDisjoint(options.manifest.sourceRoot, targetHome, "legacy sourceRoot");
  assertPathsDisjoint(options.legacyCasDir, targetHome, "legacy CAS directory");

  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  const cas = new ContentAddressedStore(path.join(targetHome, "cas"));
  await cas.initialize();

  for (const blob of options.manifest.blobs) {
    const srcFile = casObjectPath(options.legacyCasDir, blob.sha256);
    if (!existsSync(srcFile)) {
      editorFailure("ASSET_NOT_FOUND", `Source CAS object missing during import: ${blob.sha256}`);
    }
    const actual = await sha256File(srcFile);
    if (actual !== blob.sha256) {
      editorFailure(
        "ARTIFACT_HASH_MISMATCH",
        `Source CAS object hash mismatch during import: ${blob.sha256}`,
      );
    }
    const dst = cas.pathFor(blob);
    await mkdir(path.dirname(dst), { recursive: true });
    if (!existsSync(dst)) {
      await copyFile(srcFile, dst);
    }
  }

  const db = new NodeDatabaseSync(path.join(targetHome, "ave.sqlite"));
  try {
    db.exec(AVE_SQLITE_SCHEMA);
    db.prepare(
      "INSERT OR IGNORE INTO metadata(key, value) VALUES ('formatVersion', '1'), ('minReaderVersion', '1')",
    ).run();
    db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('migratedFrom', ?)").run(
      createHash("sha256").update(options.manifest.sourceRoot).digest("hex"),
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      const m = options.manifest;

      const insProj = db.prepare(
        "INSERT OR REPLACE INTO projects(project_id, title, revision, asset_manifest_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of m.projects) {
        insProj.run(r.project_id, r.title, r.revision, r.asset_manifest_hash, r.created_at);
      }

      const insGrant = db.prepare(
        "INSERT OR REPLACE INTO project_grants(project_id, principal_id, role) VALUES (?, ?, ?)",
      );
      for (const r of m.project_grants) insGrant.run(r.project_id, r.principal_id, r.role);

      const insDev = db.prepare(
        "INSERT OR REPLACE INTO devices(device_id, token_hash, role, project_ids, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const r of m.devices) {
        insDev.run(r.device_id, r.token_hash, r.role, r.project_ids, r.revoked_at, r.created_at);
      }

      const insAsset = db.prepare(
        "INSERT OR REPLACE INTO assets(asset_id, project_id, revision, document) VALUES (?, ?, ?, ?)",
      );
      for (const r of m.assets) insAsset.run(r.asset_id, r.project_id, r.revision, r.document);

      const insPlan = db.prepare(
        "INSERT OR REPLACE INTO plans(plan_id, project_id, plan_hash, revision, document) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of m.plans) {
        insPlan.run(r.plan_id, r.project_id, r.plan_hash, r.revision, r.document);
      }

      const insApp = db.prepare(
        "INSERT OR REPLACE INTO approvals(approval_id, project_id, plan_hash, purpose, request, grant, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of m.approvals) {
        insApp.run(r.approval_id, r.project_id, r.plan_hash, r.purpose, r.request, r.grant, r.created_at);
      }

      const insMut = db.prepare(
        "INSERT OR REPLACE INTO mutations(project_id, request_id, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of m.mutations) {
        insMut.run(r.project_id, r.request_id, r.fingerprint, r.response, r.created_at);
      }

      const insJob = db.prepare(
        "INSERT OR REPLACE INTO jobs(job_id, project_id, plan_hash, revision, kind, document, active) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of m.jobs) {
        insJob.run(r.job_id, r.project_id, r.plan_hash, r.revision, r.kind, r.document, r.active);
      }

      const insMtj = db.prepare(
        "INSERT OR REPLACE INTO mask_tracking_jobs(job_id, project_id, request) VALUES (?, ?, ?)",
      );
      for (const r of m.mask_tracking_jobs) insMtj.run(r.job_id, r.project_id, r.request);

      const insTmr = db.prepare(
        "INSERT OR REPLACE INTO tracked_mask_reviews(approval_id, job_id, decided_by) VALUES (?, ?, ?)",
      );
      for (const r of m.tracked_mask_reviews) insTmr.run(r.approval_id, r.job_id, r.decided_by);

      const insMa = db.prepare(
        "INSERT OR REPLACE INTO mask_anchors(mask_revision_id, project_id, approval_id, request_id, request_hash, document, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of m.mask_anchors) {
        insMa.run(
          r.mask_revision_id,
          r.project_id,
          r.approval_id,
          r.request_id,
          r.request_hash,
          r.document,
          r.approved_by,
        );
      }

      const insOe = db.prepare(
        "INSERT OR REPLACE INTO object_edits(workflow_id, project_id, asset_id, document) VALUES (?, ?, ?, ?)",
      );
      for (const r of m.object_edits) {
        insOe.run(r.workflow_id, r.project_id, r.asset_id, r.document);
      }

      const insCrs = db.prepare(
        "INSERT OR REPLACE INTO constant_rate_streams(index_sha, stream_uid) VALUES (?, ?)",
      );
      for (const r of m.constant_rate_streams) insCrs.run(r.index_sha, r.stream_uid);

      const insPs = db.prepare(
        "INSERT OR REPLACE INTO preview_sheets(artifact_id, project_id, job_id, revision, blob) VALUES (?, ?, ?, ?, ?)",
      );
      for (const r of m.preview_sheets) {
        insPs.run(r.artifact_id, r.project_id, r.job_id, r.revision, r.blob);
      }

      const insCs = db.prepare(
        "INSERT OR REPLACE INTO contact_sheets(project_id, revision, artifact_id, blob) VALUES (?, ?, ?, ?)",
      );
      for (const r of m.contact_sheets) {
        insCs.run(r.project_id, r.revision, r.artifact_id, r.blob);
      }

      const insArt = db.prepare(
        "INSERT OR REPLACE INTO artifacts(artifact_id, job_id, document) VALUES (?, ?, ?)",
      );
      for (const r of m.artifacts) insArt.run(r.artifact_id, r.job_id, r.document);

      const insEv = db.prepare(
        "INSERT OR REPLACE INTO events(project_id, seq, document) VALUES (?, ?, ?)",
      );
      for (const r of m.events) insEv.run(r.project_id, r.seq, r.document);

      const insOb = db.prepare(
        "INSERT OR REPLACE INTO outbox(event_id, project_id, seq, document) VALUES (?, ?, ?, ?)",
      );
      for (const r of m.outbox) insOb.run(r.event_id, r.project_id, r.seq, r.document);

      const insMp = db.prepare(
        "INSERT OR REPLACE INTO model_policies(project_id, provider, model_id, document) VALUES (?, ?, ?, ?)",
      );
      for (const r of m.model_policies) {
        insMp.run(r.project_id, r.provider, r.model_id, r.document);
      }

      const insSet = db.prepare(
        "INSERT OR REPLACE INTO project_settings(project_id, document) VALUES (?, ?)",
      );
      for (const r of m.project_settings) insSet.run(r.project_id, r.document);

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return {
      projects: options.manifest.projects.length,
      assets: options.manifest.assets.length,
      plans: options.manifest.plans.length,
      approvals: options.manifest.approvals.length,
      jobs: options.manifest.jobs.length,
      objectEdits: options.manifest.object_edits.length,
      devices: options.manifest.devices.length,
      blobs: options.manifest.blobs.length,
    };
  } finally {
    db.close();
  }
}
