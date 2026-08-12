// SQLite persistence layer for Hermes Video Studio.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (mode IN ('AUTO','MANUAL')),
  stage TEXT NOT NULL DEFAULT 'planning',
  countdown_seconds INTEGER NOT NULL DEFAULT 5,
  budget_soft REAL NOT NULL DEFAULT 5.0,
  budget_hard REAL NOT NULL DEFAULT 10.0,
  spend REAL NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 2,
  pause_on_failed_shot INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_seconds REAL NOT NULL DEFAULT 4,
  image_prompt TEXT NOT NULL DEFAULT '',
  video_prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','image_generating','image_review','video_generating','video_review','complete','failed')),
  approved_image_asset_id INTEGER,
  approved_video_asset_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id INTEGER REFERENCES shots(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','link','file')),
  content TEXT NOT NULL DEFAULT '',
  path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id INTEGER REFERENCES shots(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('image','video')),
  path TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',
  ai_score REAL NOT NULL DEFAULT 0,
  ai_selected INTEGER NOT NULL DEFAULT 0,
  user_selected INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  round INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id INTEGER REFERENCES shots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  status TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('NOW','NEXT','QUEUED','COMPLETE','FAILED','CANCELLED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL UNIQUE,
  provider_job_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video')),
  round INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paused')),
  countdown_seconds INTEGER NOT NULL DEFAULT 5,
  deadline INTEGER,
  decided_candidate_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  shot_id INTEGER,
  job_id INTEGER,
  kind TEXT,
  provider TEXT,
  cost REAL NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_SETTINGS = {
  global_stop: '0', // 1 = hard stop, nothing runs
  automation_paused: '0', // 1 = no new queue work, state preserved
  active_project_id: '',
  mock_latency_ms: '1200',
  tick_ms: '400',
  image_cost: '0.02',
  video_cost: '0.10',
  image_candidates: '3',
  video_candidates: '2',
};

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!get.get(k)) ins.run(k, v);
  }
  return db;
}

export function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function allSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function slugify(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
  return base;
}
