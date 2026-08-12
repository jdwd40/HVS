// Test helpers: fresh temp db + media dir + engine per suite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting } from '../server/db.js';
import { createEngine } from '../server/worker.js';
import { createApp } from '../server/app.js';
import { _resetMockProviders } from '../server/providers.js';

export function makeWorld({ latencyMs = 40, tickMs = 20 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvs-test-'));
  const dbPath = path.join(dir, 'test.db');
  const mediaDir = path.join(dir, 'media');
  const db = openDb(dbPath);
  setSetting(db, 'mock_latency_ms', String(latencyMs));
  setSetting(db, 'tick_ms', String(tickMs));
  const engine = createEngine({ db, mediaDir });
  const app = createApp({ db, engine, mediaDir, distDir: null });
  _resetMockProviders();
  return {
    db, engine, app, mediaDir, dbPath, dir,
    cleanup() {
      engine.stop();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function runUntil(fn, { timeoutMs = 5000, intervalMs = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('runUntil timed out');
}

export function seedProject(db, { mode = 'AUTO', countdown = 1 } = {}) {
  const info = db.prepare(
    "INSERT INTO projects (name, slug, mode, countdown_seconds) VALUES (?, ?, ?, ?)"
  ).run('Test Project', `test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, mode, countdown);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
}

export function seedShot(db, projectId, ord = 1, title = 'Opening') {
  const info = db.prepare(
    'INSERT INTO shots (project_id, ord, title, description) VALUES (?,?,?,?)'
  ).run(projectId, ord, title, `${title} description`);
  return db.prepare('SELECT * FROM shots WHERE id = ?').get(info.lastInsertRowid);
}
