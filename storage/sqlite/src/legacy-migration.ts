import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import os from "node:os";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync as NodeDatabaseSync, type SQLInputValue } from "node:sqlite";
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

function referencedBlobs(rows: Pick<MigrationManifest, "assets" | "jobs" | "artifacts" | "mask_anchors" | "preview_sheets" | "contact_sheets">) {
  const refs = new Map<string, BlobRef>();
  for (const table of [rows.assets, rows.jobs, rows.artifacts, rows.mask_anchors]) {
    for (const row of table) collectBlobRefs(JSON.parse(row.document), refs);
  }
  for (const table of [rows.preview_sheets, rows.contact_sheets]) {
    for (const row of table) collectBlobRefs(JSON.parse(row.blob), refs);
  }
  return refs;
}

function casObjectPath(casDir: string, sha256Hex: string): string {
  const historical = new ContentAddressedStore(casDir).pathFor({ sha256: sha256Hex });
  if (existsSync(historical)) return historical;
  const flat = path.join(casDir, sha256Hex);
  if (existsSync(flat)) return flat;
  const sharded = path.join(casDir, "blobs", sha256Hex.slice(0, 2), sha256Hex);
  if (existsSync(sharded)) return sharded;
  const objs = path.join(casDir, "objects", sha256Hex.slice(0, 2), sha256Hex);
  if (existsSync(objs)) return objs;
  return historical;
}

function resolvePhysicalPath(value: string): string {
  const absolute = path.resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  return path.join(resolvePhysicalPath(path.dirname(absolute)), path.basename(absolute));
}

async function fileVersion(file: string): Promise<string | null> {
  try {
    const info = await stat(file, { bigint: true });
    return [info.dev, info.ino, info.size, info.ctimeNs].join("/");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// Opening a WAL database can create or modify its -shm sidecar even in read-only mode.
async function openSnapshot(file: string, directory: string): Promise<ReadonlySqlite> {
  const names = [file, file + "-wal"];
  const before = await Promise.all(names.map(fileVersion));
  for (const [i, name] of names.entries()) {
    if (before[i]) await copyFile(name, path.join(directory, path.basename(name)));
  }
  const after = await Promise.all(names.map(fileVersion));
  if (before.some((value, i) => value !== after[i])) {
    editorFailure("REVISION_CONFLICT", "Legacy database changed during export. Retry the export.");
  }
  return new DatabaseSyncReadonly(path.join(directory, path.basename(file)), { readOnly: true });
}

function assertPathsDisjoint(sourceRoot: string, targetRoot: string, label: string): void {
  const src = resolvePhysicalPath(sourceRoot);
  const dst = resolvePhysicalPath(targetRoot);
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
  if (options.outputManifestPath) assertPathsDisjoint(sourceRoot, options.outputManifestPath, "legacy sourceRoot");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "ave-legacy-db-"));
  let snapshot: ReadonlySqlite | undefined;
  try {
    const db = snapshot = await openSnapshot(sqlitePath, temporary);
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
          created_at: dev.createdAt ?? new Date(0).toISOString(),
        });
      }
    }

    const blobMap = referencedBlobs({ assets, jobs, artifacts, mask_anchors, preview_sheets, contact_sheets });
    for (const blob of blobMap.values()) {
      const srcFile = casObjectPath(casDir, blob.sha256);
      if (!existsSync(srcFile)) {
        editorFailure("ASSET_NOT_FOUND", `Legacy CAS object missing: ${blob.sha256}`);
      }
      const actual = await sha256File(srcFile);
      if (actual !== blob.sha256 || (await stat(srcFile)).size.toString() !== blob.bytes) {
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
      const directory = path.dirname(path.resolve(options.outputManifestPath));
      await mkdir(directory, { recursive: true });
      const temporaryManifest = path.join(directory, ".ave-migration-" + randomUUID());
      try {
        await writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporaryManifest, options.outputManifestPath);
      } finally {
        await rm(temporaryManifest, { force: true });
      }
    }
    return manifest;
  } finally {
    snapshot?.close();
    await rm(temporary, { recursive: true, force: true });
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

const migrationTables = [
  "projects", "project_grants", "devices", "assets", "plans", "approvals", "mutations",
  "jobs", "mask_tracking_jobs", "tracked_mask_reviews", "mask_anchors", "object_edits",
  "constant_rate_streams", "preview_sheets", "contact_sheets", "artifacts", "events",
  "outbox", "model_policies", "project_settings",
] as const;

function mergeRows(db: NodeDatabaseSync, manifest: MigrationManifest): void {
  for (const table of migrationTables) {
    const rows = manifest[table];
    if (!rows.length) continue;
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const columns = info.map((column) => String(column.name));
    const keys = info.filter((column) => column.pk).map((column) => String(column.name));
    const where = keys.map((key) => key + " = ?").join(" AND ");
    const existing = db.prepare(`SELECT * FROM ${table} WHERE ${where}`);
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of rows) {
      const values: Record<string, SQLInputValue> = row;
      const identity = keys.map((key) => values[key]);
      const previous = existing.get(...identity);
      if (!previous) insert.run(...columns.map((column) => values[column]));
      else if (columns.some((column) => previous[column] !== values[column])) {
        editorFailure("REVISION_CONFLICT", `Migration conflict in ${table} (${identity.join(", ")})`);
      }
    }
  }
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

  const declared = new Map(options.manifest.blobs.map(blob => [blob.sha256, blob.bytes]));
  for (const ref of referencedBlobs(options.manifest).values()) {
    if (declared.get(ref.sha256) !== ref.bytes) editorFailure("ARTIFACT_HASH_MISMATCH", "Manifest omits or changes a referenced blob: " + ref.sha256);
  }

  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  const cas = new ContentAddressedStore(path.join(targetHome, "cas"));
  await cas.initialize();

  const staging = await mkdtemp(path.join(targetHome, "cas", "temporary", "migration-"));
  let database: NodeDatabaseSync | undefined;
  try {
    const objects = new Map<string, { source: string; destination: string }>();
    for (const blob of options.manifest.blobs) {
      const destination = cas.pathFor(blob);
      const legacy = casObjectPath(options.legacyCasDir, blob.sha256);
      if (!existsSync(legacy)) editorFailure("ASSET_NOT_FOUND", `Source CAS object missing: ${blob.sha256}`);
      const source = path.join(staging, blob.sha256);
      await copyFile(legacy, source);
      if ((await stat(source)).size.toString() !== blob.bytes || await sha256File(source) !== blob.sha256) {
        editorFailure("ARTIFACT_HASH_MISMATCH", `Legacy CAS object corrupted: ${blob.sha256}`);
      }
      if (existsSync(destination) && !await cas.verifyBlob(blob)) {
        editorFailure("ARTIFACT_HASH_MISMATCH", `Native CAS object corrupted: ${blob.sha256}`);
      }
      objects.set(blob.sha256, { source, destination });
    }

    const db = database = new NodeDatabaseSync(path.join(targetHome, "ave.sqlite"));
    db.exec(AVE_SQLITE_SCHEMA);
    db.exec("BEGIN IMMEDIATE");
    const published: string[] = [];
    try {
      mergeRows(db, options.manifest);
      db.exec("INSERT OR IGNORE INTO metadata(key, value) VALUES ('formatVersion', '1'), ('minReaderVersion', '1')");
      db.prepare("INSERT INTO metadata(key, value) VALUES ('migratedFrom', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value <> excluded.value")
        .run(createHash("sha256").update(options.manifest.sourceRoot).digest("hex"));
      for (const { source, destination } of objects.values()) {
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        try {
          linkSync(source, destination);
          published.push(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        for (const file of published) unlinkSync(file);
      } finally {
        db.exec("ROLLBACK");
      }
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
    database?.close();
    await rm(staging, { recursive: true, force: true });
  }
}
