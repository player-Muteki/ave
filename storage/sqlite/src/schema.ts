export const AVE_SQLITE_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  revision TEXT NOT NULL,
  asset_manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_grants (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY(project_id, principal_id)
);
CREATE INDEX IF NOT EXISTS idx_project_grants_principal ON project_grants(principal_id);

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  project_ids TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
  invitation_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  project_ids TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision TEXT NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  plan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  plan_hash TEXT NOT NULL,
  revision TEXT NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  plan_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  request TEXT NOT NULL,
  grant TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mutations (
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, request_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  plan_hash TEXT NOT NULL,
  revision TEXT NOT NULL,
  kind TEXT NOT NULL,
  document TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS active_job_semantics
  ON jobs(project_id, plan_hash, revision, kind) WHERE active = 1;

CREATE TABLE IF NOT EXISTS mask_tracking_jobs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  request TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracked_mask_reviews (
  approval_id TEXT PRIMARY KEY REFERENCES approvals(approval_id),
  job_id TEXT NOT NULL REFERENCES mask_tracking_jobs(job_id),
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracked_reviews_job ON tracked_mask_reviews(job_id);

CREATE TABLE IF NOT EXISTS mask_anchors (
  mask_revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  approval_id TEXT NOT NULL REFERENCES approvals(approval_id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  document TEXT NOT NULL,
  approved_by TEXT,
  UNIQUE(project_id, request_id)
);

CREATE TABLE IF NOT EXISTS object_edits (
  workflow_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  asset_id TEXT NOT NULL,
  document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_object_edits_project ON object_edits(project_id);

CREATE TABLE IF NOT EXISTS constant_rate_streams (
  index_sha TEXT NOT NULL,
  stream_uid TEXT NOT NULL,
  PRIMARY KEY(index_sha, stream_uid)
);

CREATE TABLE IF NOT EXISTS preview_sheets (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  revision TEXT NOT NULL,
  blob TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contact_sheets (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY(project_id, revision, artifact_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY(project_id, seq)
);
CREATE INDEX IF NOT EXISTS events_by_run_seq
  ON events(project_id, json_extract(document, '$.runId'), CAST(seq AS INTEGER));

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expected_size TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL,
  display_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  next_offset TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_policies (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY(project_id, provider, model_id)
);

CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  document TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_receipts (
  upload_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE(project_id, request_id),
  FOREIGN KEY(project_id, request_id) REFERENCES mutations(project_id, request_id)
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id TEXT NOT NULL,
  offset TEXT NOT NULL,
  chunk_sha256 TEXT NOT NULL,
  PRIMARY KEY(upload_id, offset)
);
`;
