#!/usr/bin/env node
/**
 * Legacy-to-native AVE project migration CLI (`ave.migration/v1`).
 * Usage:
 *   node scripts/migrate_legacy_project.mjs export --legacy-dir <dir> --out <manifest.json>
 *   node scripts/migrate_legacy_project.mjs import --manifest <manifest.json> --legacy-cas <dir> --target-home <aveHome>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { exportLegacyProjectManifest, importMigrationManifest } from "../storage/sqlite/dist/index.js";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const val = rest[i + 1];
    if (!key?.startsWith("--") || !val) {
      throw new Error(`Invalid CLI argument near ${key ?? ""}`);
    }
    flags[key.slice(2)] = val;
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === "export") {
    if (!flags["legacy-dir"] || !flags.out) {
      throw new Error("export requires --legacy-dir and --out");
    }
    const manifest = await exportLegacyProjectManifest({
      legacyRootDir: path.resolve(flags["legacy-dir"]),
      outputManifestPath: path.resolve(flags.out),
    });
    console.log(
      JSON.stringify({
        ok: true,
        schemaVersion: manifest.schemaVersion,
        projects: manifest.projects.length,
        blobs: manifest.blobs.length,
        manifestPath: path.resolve(flags.out),
      }),
    );
    return;
  }

  if (command === "import") {
    if (!flags.manifest || !flags["legacy-cas"] || !flags["target-home"]) {
      throw new Error("import requires --manifest, --legacy-cas, and --target-home");
    }
    const manifest = JSON.parse(await readFile(path.resolve(flags.manifest), "utf8"));
    const result = await importMigrationManifest({
      manifest,
      legacyCasDir: path.resolve(flags["legacy-cas"]),
      targetAveHome: path.resolve(flags["target-home"]),
    });
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }

  throw new Error("Unknown command. Use 'export' or 'import'.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
