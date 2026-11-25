/** The same tables on SQLite and Postgres. Every row belongs to a workspace; a laptop uses "local". */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  agent TEXT NOT NULL,
  person TEXT NOT NULL,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  git_branch TEXT,
  model TEXT,
  agent_version TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  tool_errors INTEGER NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL,
  active_ms BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  brief TEXT,
  received_at TEXT NOT NULL,
  pushed_at TEXT,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX IF NOT EXISTS sessions_ended ON sessions (workspace, ended_at);

CREATE TABLE IF NOT EXISTS steps (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  is_error INTEGER NOT NULL,
  at TEXT NOT NULL,
  duration_ms INTEGER,
  sidechain INTEGER NOT NULL,
  PRIMARY KEY (workspace, session_id, seq)
);
CREATE INDEX IF NOT EXISTS steps_tool ON steps (workspace, kind, name);

CREATE TABLE IF NOT EXISTS memory (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  op TEXT NOT NULL,
  ref TEXT NOT NULL,
  preview TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace, session_id, idx)
);
CREATE INDEX IF NOT EXISTS memory_ref ON memory (workspace, ref);

CREATE TABLE IF NOT EXISTS findings (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (workspace, session_id, key)
);
CREATE INDEX IF NOT EXISTS findings_key ON findings (workspace, key);

CREATE TABLE IF NOT EXISTS issues (
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  note TEXT,
  reopened INTEGER NOT NULL DEFAULT 0,
  num INTEGER,
  PRIMARY KEY (workspace, key)
);

CREATE TABLE IF NOT EXISTS suggestions (
  workspace TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  detail TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);

CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  person TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`;
