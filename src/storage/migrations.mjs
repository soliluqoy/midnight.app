// Ordered schema migrations. Each runs in its own transaction; PRAGMA user_version records the last applied one.
// Never edit a shipped migration: append a new one. Older binaries refuse newer data (see db.mjs).

export const MIGRATIONS = [
	{
		version: 1,
		name: "mission core",
		sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Append-only domain journal. seq is the monotonic order the renderer replays from.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  mission_id TEXT NOT NULL DEFAULT '',
  run_id TEXT,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  payload_ref TEXT
);
CREATE INDEX events_mission ON events (mission_id, seq);

-- Sensitive or large content lives apart from operational metadata so retention can delete it.
CREATE TABLE payloads (
  ref TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX payloads_mission ON payloads (mission_id);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  non_goals TEXT NOT NULL DEFAULT '[]',
  owner TEXT NOT NULL DEFAULT 'user',
  trigger TEXT NOT NULL DEFAULT '{"kind":"user"}',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  deadline TEXT,
  scope TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'ask',
  model_policy TEXT NOT NULL DEFAULT '{}',
  budget_id TEXT,
  conversation TEXT,
  plan_revision INTEGER NOT NULL DEFAULT 0,
  skill TEXT,
  watch_id TEXT,
  outcome TEXT NOT NULL DEFAULT '{}',
  waiting TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX missions_status ON missions (archived, updated_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  input TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  runtime_version TEXT NOT NULL,
  model_route TEXT NOT NULL DEFAULT '{}',
  outcome TEXT,
  checkpoint TEXT NOT NULL DEFAULT '{}',
  recovery_reason TEXT
);
CREATE INDEX runs_mission ON runs (mission_id, started_at);

CREATE TABLE plan_revisions (
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  prior_revision INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  assumptions TEXT NOT NULL DEFAULT '[]',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  nodes TEXT NOT NULL,
  checks TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, revision)
);

CREATE TABLE step_states (
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  retries INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, revision, node_id)
);

CREATE TABLE action_intents (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  run_id TEXT,
  tool TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  effect TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  args_hash TEXT NOT NULL,
  args_ref TEXT,
  display TEXT NOT NULL DEFAULT '{}',
  authority TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX intents_mission ON action_intents (mission_id, created_at);
CREATE INDEX intents_hash ON action_intents (mission_id, args_hash);
CREATE INDEX intents_state ON action_intents (state);

-- Receipts are append-only: a correction appends a newer record.
CREATE TABLE action_receipts (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  state TEXT NOT NULL,
  remote_id TEXT,
  result_hash TEXT,
  observed TEXT NOT NULL DEFAULT '{}',
  verification TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX receipts_intent ON action_receipts (intent_id, created_at);

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL,
  origin TEXT NOT NULL,
  action_classes TEXT NOT NULL,
  account TEXT,
  roots TEXT NOT NULL DEFAULT '[]',
  destinations TEXT NOT NULL DEFAULT '[]',
  limits TEXT NOT NULL DEFAULT '{}',
  used INTEGER NOT NULL DEFAULT 0,
  schedule TEXT,
  mission_id TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  status TEXT NOT NULL,
  display TEXT NOT NULL,
  created_at TEXT NOT NULL,
  displayed_at TEXT,
  decided_at TEXT,
  decision TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX approvals_status ON approvals (status);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  recurrence TEXT NOT NULL,
  timezone TEXT NOT NULL,
  threshold TEXT NOT NULL DEFAULT '{}',
  cooldown_s INTEGER NOT NULL DEFAULT 0,
  missed_run TEXT NOT NULL DEFAULT 'coalesce',
  on_change TEXT NOT NULL DEFAULT 'notify',
  prompt TEXT,
  fingerprint TEXT,
  snapshot_ref TEXT,
  next_due TEXT,
  last_check_at TEXT,
  last_change_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  grant_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE occurrences (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  outcome TEXT,
  coalesced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE leases (
  resource TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  run_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  local_path TEXT NOT NULL,
  published_path TEXT,
  remote_location TEXT,
  validation TEXT NOT NULL DEFAULT '{}',
  sources TEXT NOT NULL DEFAULT '[]',
  tool_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_mission ON artifacts (mission_id, created_at);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  source_version TEXT,
  locator TEXT NOT NULL DEFAULT '{}',
  excerpt_ref TEXT,
  hash TEXT,
  captured_at TEXT NOT NULL,
  freshness TEXT,
  derived TEXT
);
CREATE INDEX evidence_mission ON evidence (mission_id, captured_at);

CREATE TABLE memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT '{}',
  confirmed INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  confidence REAL NOT NULL DEFAULT 1,
  valid_until TEXT,
  superseded_by TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  limits TEXT NOT NULL,
  spent TEXT NOT NULL DEFAULT '{}',
  reserved TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL,
  group_key TEXT NOT NULL DEFAULT '',
  mission_id TEXT,
  watch_id TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',
  suggested_action TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  quiet_until TEXT
);
CREATE INDEX notifications_dedup ON notifications (dedup_key, created_at);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_mission TEXT,
  template TEXT NOT NULL,
  reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE secrets (
  ref TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
	},
];

export const LATEST_SCHEMA = MIGRATIONS[MIGRATIONS.length - 1].version;
