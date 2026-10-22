import { mkdirSync, chmodSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Schema migrations, applied in order. PRAGMA user_version records how many have run, so a database
// written by an older server is upgraded in place and an up-to-date one is left alone.
const MIGRATIONS = [
  `
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    captured_at TEXT NOT NULL,
    date TEXT NOT NULL,
    cost_date TEXT,
    cost_source TEXT,
    projects TEXT NOT NULL,
    sections TEXT NOT NULL,
    errors TEXT NOT NULL,
    summary TEXT NOT NULL
  );
  CREATE INDEX snapshots_date ON snapshots(date);

  CREATE TABLE snapshot_results (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    section TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, section)
  );

  CREATE TABLE metrics (
    date TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    resource TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
    PRIMARY KEY (date, project_id, kind, resource, metric)
  );
  CREATE INDEX metrics_lookup ON metrics(kind, metric, resource, date);

  CREATE TABLE reports (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
    tags TEXT NOT NULL
  );
  CREATE INDEX reports_date ON reports(date);

  CREATE TABLE findings (
    id INTEGER PRIMARY KEY,
    snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE CASCADE,
    report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    resource TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    fingerprint TEXT NOT NULL
  );
  CREATE INDEX findings_date ON findings(date);
  CREATE INDEX findings_fingerprint ON findings(fingerprint, date);
  CREATE INDEX findings_snapshot ON findings(snapshot_id);
  `,
  // 2: snapshots cover one whole day; record the exact window the metrics, incidents and logs came from.
  `
  ALTER TABLE snapshots ADD COLUMN window_start TEXT;
  ALTER TABLE snapshots ADD COLUMN window_end TEXT;
  ALTER TABLE findings ADD COLUMN section TEXT;
  CREATE INDEX metrics_date ON metrics(date, kind);
  `,
  // 3: planned events (sales...) with their scale-up and scale-down allowance, so anomaly checks expect them.
  `
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    prep_days INTEGER NOT NULL DEFAULT 0,
    cooldown_days INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX events_dates ON events(start_date, end_date);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// Opens (and creates, if needed) the history database. The file can hold resource names, alert names
// and costs, so its folder is private to the user (0700) and the file is 0600.
export function openHistoryDb(path, { readOnly = false } = {}) {
  const memory = path === ':memory:';
  if (!memory && !readOnly) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path, { readOnly });
  // Claude Desktop and Claude Code may each run a server on the same file: WAL lets readers and one
  // writer work at once, and busy_timeout waits for a lock instead of failing.
  db.exec('PRAGMA busy_timeout = 5000');
  if (readOnly) return db;
  if (!memory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `The history database was written by a newer gcp-monitor-mcp (schema ${current}, this server knows ${SCHEMA_VERSION}). Update the server.`,
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
