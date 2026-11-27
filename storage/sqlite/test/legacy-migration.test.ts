import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ContentAddressedStore } from "@ave/cas";
import {
  AVE_SQLITE_SCHEMA,
  AveStore,
  MIGRATION_SCHEMA_VERSION,
  exportLegacyProjectManifest,
  importMigrationManifest,
} from "../src/index.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Legacy Paseo -> Native AVE Migration Tool", () => {
  it("exports read-only manifest, verifies SHA-256 blobs, rejects overlap/tampering, and imports into isolated AVE_HOME", async () => {
    const legacyRoot = await makeTempDir("ave-legacy-src-");
    const targetHome = await makeTempDir("ave-native-dst-");
    const manifestPath = path.join(await makeTempDir("ave-manifest-"), "migration.json");

    // 1. Seed synthetic legacy editor.sqlite + CAS + access.json
    const legacyCas = path.join(legacyRoot, "cas");
    await mkdir(legacyCas, { recursive: true });
    const sampleVideoBytes = Buffer.from("fake-immutable-mp4-payload-for-migration-check");
    const videoSha = sha256Hex(sampleVideoBytes);
    const indexBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: "video.presentation-index/v2",
        sourceSha256: videoSha,
        streams: [],
        frames: [],
      }),
    );
    const indexSha = sha256Hex(indexBytes);
    const probeBytes = Buffer.from(JSON.stringify({ streams: [] }));
    const probeSha = sha256Hex(probeBytes);

    for (const [sha, bytes] of [
      [videoSha, sampleVideoBytes],
      [indexSha, indexBytes],
      [probeSha, probeBytes],
    ] as const) {
      const shardDir = path.join(legacyCas, "blobs", sha.slice(0, 2));
      await mkdir(shardDir, { recursive: true });
      await writeFile(path.join(shardDir, sha), bytes);
    }

    const now = new Date().toISOString();
    const projectId = "proj-legacy-1";
    const legacyDb = new DatabaseSync(path.join(legacyRoot, "editor.sqlite"));
    legacyDb.exec(AVE_SQLITE_SCHEMA);
    legacyDb
      .prepare(
        "INSERT INTO projects(project_id, title, revision, asset_manifest_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(projectId, "Legacy Video Project", "1", sha256Hex("manifest"), now);
    legacyDb
      .prepare("INSERT INTO project_grants(project_id, principal_id, role) VALUES (?, ?, ?)")
      .run(projectId, "owner", "owner");
    legacyDb
      .prepare("INSERT INTO assets(asset_id, project_id, revision, document) VALUES (?, ?, ?, ?)")
      .run(
        "asset-1",
        projectId,
        "1",
        JSON.stringify({
          assetId: "asset-1",
          displayName: "legacy.mp4",
          original: {
            sha256: videoSha,
            bytes: String(sampleVideoBytes.byteLength),
            mediaType: "video/mp4",
          },
          presentationIndex: {
            sha256: indexSha,
            bytes: String(indexBytes.byteLength),
            mediaType: "application/json",
          },
          probe: {
            sha256: probeSha,
            bytes: String(probeBytes.byteLength),
            mediaType: "application/json",
          },
          streams: [
            {
              streamUid: "v-0",
              streamIndex: 0,
              kind: "video",
              codec: "h264",
              timeBase: { num: "1", den: "25" },
              disposition: {},
            },
          ],
          sourceNeverWritable: true,
        }),
      );
    legacyDb
      .prepare("INSERT INTO events(project_id, seq, document) VALUES (?, ?, ?)")
      .run(
        projectId,
        "1",
        JSON.stringify({
          protocolVersion: "1",
          projectId,
          eventId: "ev-1",
          seq: "1",
          occurredAt: now,
          type: "project.created",
          payload: { title: "Legacy Video Project" },
        }),
      );
    legacyDb.close();

    await writeFile(
      path.join(legacyRoot, "access.json"),
      JSON.stringify({
        version: 1,
        devices: [
          {
            deviceId: "mob-dev-1",
            tokenHash: sha256Hex("paired-cred-secret"),
            role: "operator",
            projectIds: [projectId],
          },
        ],
        invitations: [],
      }),
    );

    // 2. Export manifest read-only
    const manifest = await exportLegacyProjectManifest({
      legacyRootDir: legacyRoot,
      outputManifestPath: manifestPath,
    });
    expect(manifest.schemaVersion).toBe(MIGRATION_SCHEMA_VERSION);
    expect(manifest.projects).toHaveLength(1);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.devices).toHaveLength(1);
    expect(manifest.blobs).toHaveLength(3);
    const written = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(written.projects[0].title).toBe("Legacy Video Project");

    // 3. Reject overlapping targetAveHome sharing legacy DB/CAS
    await expect(
      importMigrationManifest({
        manifest,
        legacyCasDir: legacyCas,
        targetAveHome: legacyRoot,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    // 4. Clean import into isolated native AVE_HOME
    const imported = await importMigrationManifest({
      manifest,
      legacyCasDir: legacyCas,
      targetAveHome: targetHome,
    });
    expect(imported).toMatchObject({
      projects: 1,
      assets: 1,
      devices: 1,
      blobs: 3,
    });

    // 5. Verify native AveStore + ContentAddressedStore read migrated project & verify hashes
    const nativeStore = await AveStore.create(targetHome);
    const nativeCas = new ContentAddressedStore(path.join(targetHome, "cas"));
    await nativeCas.initialize();
    nativeStore.bindCas(nativeCas);

    const owner = { principalId: "owner", role: "owner" as const, projectIds: null };
    const snap = nativeStore.projects.getProjectSnapshot(projectId, owner);
    expect(snap.title).toBe("Legacy Video Project");
    expect(snap.assets).toHaveLength(1);
    const devPrincipal = nativeStore.devices.authenticate("mob-dev-1", "paired-cred-secret");
    expect(devPrincipal.role).toBe("operator");
    expect(
      await nativeCas.verifyBlob({
        sha256: videoSha,
        bytes: String(sampleVideoBytes.byteLength),
        mediaType: "video/mp4",
      }),
    ).toBe(true);
    nativeStore.close();

    // 6. Reject tampered legacy blob on export
    await writeFile(
      path.join(legacyCas, "blobs", videoSha.slice(0, 2), videoSha),
      Buffer.from("corrupted"),
    );
    await expect(
      exportLegacyProjectManifest({ legacyRootDir: legacyRoot }),
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  });
});
