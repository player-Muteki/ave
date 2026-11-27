import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { ContentAddressedStore } from "@ave/cas";
import { EditorEventSchema, editorFailure, type EditorEvent } from "@ave/contracts";
import { sha256Json } from "@ave/domain";
import { AVE_SQLITE_SCHEMA } from "./schema.js";

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const DatabaseSync = NodeDatabaseSync as new (location: string) => SqliteDatabase;

export function resolveAveHome(override?: string): string {
  const root = path.resolve(override ?? process.env.AVE_HOME ?? path.join(os.homedir(), ".ave"));
  const normalized = root.replace(/\\/g, "/");
  if (normalized.endsWith("/video-editor") || normalized.includes("/.paseo/")) {
    editorFailure(
      "INVALID_ARGUMENT",
      "Native AVE_HOME must stay isolated from legacy Paseo video-editor directories",
    );
  }
  return root;
}

export class TransactionCoordinator {
  readonly db: SqliteDatabase;
  private transactionDepth = 0;
  private cas?: ContentAddressedStore;

  static async open(rootDir?: string): Promise<TransactionCoordinator> {
    const root = resolveAveHome(rootDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    return new TransactionCoordinator(path.join(root, "ave.sqlite"));
  }

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec(AVE_SQLITE_SCHEMA);
      const version = this.db
        .prepare("SELECT value FROM metadata WHERE key = 'formatVersion'")
        .get() as { value: string } | undefined;
      if (version && version.value !== "1") {
        editorFailure("SCHEMA_UNSUPPORTED", "The project database requires a newer reader");
      }
      this.db
        .prepare(
          "INSERT OR IGNORE INTO metadata(key, value) VALUES ('formatVersion', '1'), ('minReaderVersion', '1')",
        )
        .run();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  bindCas(cas: ContentAddressedStore): void {
    this.cas = cas;
  }

  requireCas(): ContentAddressedStore {
    if (!this.cas) {
      editorFailure("CAPABILITY_UNAVAILABLE", "The CAS reader is not bound to the store");
    }
    return this.cas;
  }

  getCas(): ContentAddressedStore | undefined {
    return this.cas;
  }

  close(): void {
    this.db.close();
  }

  now(): string {
    return new Date().toISOString();
  }

  rows(sql: string, ...params: unknown[]): string[] {
    const stmt = this.db.prepare(sql);
    const result = stmt.all(...params) as Array<Record<string, unknown>>;
    return result.map((row) => Object.values(row)[0] as string);
  }

  runInTransaction<T>(fn: () => T): T {
    this.begin();
    try {
      const value = fn();
      this.commit();
      return value;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  mutate<Input, Output>(input: {
    projectId: string;
    requestId: string;
    payload: Input;
    execute: (projectId: string) => Output;
  }): Output {
    const fingerprint = sha256Json(input.payload);
    return this.runInTransaction(() => {
      const existing = this.db
        .prepare(
          "SELECT fingerprint, response FROM mutations WHERE project_id = ? AND request_id = ?",
        )
        .get(input.projectId, input.requestId) as
        | { fingerprint: string; response: string }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          editorFailure(
            "IDEMPOTENCY_CONFLICT",
            "The request identifier was used with different content",
          );
        }
        return JSON.parse(existing.response) as Output;
      }
      const output = input.execute(input.projectId);
      this.db
        .prepare(
          "INSERT INTO mutations(project_id, request_id, fingerprint, response, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(input.projectId, input.requestId, fingerprint, JSON.stringify(output), this.now());
      return output;
    });
  }

  latestSeq(projectId: string): string {
    const row = this.db
      .prepare("SELECT MAX(CAST(seq AS INTEGER)) AS seq FROM events WHERE project_id = ?")
      .get(projectId) as { seq: number | null };
    return (row.seq ?? 0).toString();
  }

  emit(
    projectId: string,
    type: string,
    payload: unknown,
    context?: Pick<EditorEvent, "runId" | "sessionId" | "causationId" | "jobId">,
  ): EditorEvent {
    const seq = (BigInt(this.latestSeq(projectId)) + 1n).toString();
    const event = EditorEventSchema.parse({
      protocolVersion: "1",
      projectId,
      eventId: randomUUID(),
      ...context,
      ...(type.startsWith("run.") && payload && typeof payload === "object" && "runId" in payload
        ? { runId: (payload as { runId?: string }).runId }
        : {}),
      seq,
      occurredAt: this.now(),
      type,
      payload,
    });
    const document = JSON.stringify(event);
    this.db
      .prepare("INSERT INTO events(project_id, seq, document) VALUES (?, ?, ?)")
      .run(projectId, seq, document);
    this.db
      .prepare("INSERT INTO outbox(event_id, project_id, seq, document) VALUES (?, ?, ?, ?)")
      .run(event.eventId, projectId, seq, document);
    return event;
  }

  private begin(): void {
    if (this.transactionDepth++ === 0) this.db.exec("BEGIN IMMEDIATE");
  }

  private commit(): void {
    if (--this.transactionDepth === 0) this.db.exec("COMMIT");
  }

  private rollback(): void {
    if (--this.transactionDepth === 0) this.db.exec("ROLLBACK");
  }
}
