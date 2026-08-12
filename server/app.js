// Express API + static hosting for Hermes Video Studio.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { allSettings, getSetting, setSetting, slugify } from './db.js';
import { listAgents } from './agent.js';

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApp({ db, engine, mediaDir, distDir }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // ---------- health ----------
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'hermes-video-studio', time: new Date().toISOString() });
  });

  // ---------- projects ----------
  app.get('/api/projects', (req, res) => {
    const projects = db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id) AS shot_count,
        (SELECT COUNT(*) FROM shots s WHERE s.project_id = p.id AND s.status = 'complete') AS shots_complete
      FROM projects p ORDER BY p.updated_at DESC`).all();
    res.json({ projects, activeProjectId: Number(getSetting(db, 'active_project_id')) || null });
  });

  app.post('/api/projects', (req, res) => {
    const { name, mode = 'AUTO', countdown_seconds = 5, budget_soft = 5, budget_hard = 10 } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    let slug = slugify(name);
    let i = 2;
    while (db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${i++}`;
    const info = db.prepare(
      `INSERT INTO projects (name, slug, mode, countdown_seconds, budget_soft, budget_hard)
       VALUES (?,?,?,?,?,?)`
    ).run(String(name).trim(), slug, mode === 'MANUAL' ? 'MANUAL' : 'AUTO',
      Math.max(1, Number(countdown_seconds) || 5), Number(budget_soft) || 0, Number(budget_hard) || 0);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid);
    setSetting(db, 'active_project_id', String(project.id));
    res.status(201).json({ project });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    res.json({ project });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const fields = ['name', 'mode', 'stage', 'countdown_seconds', 'budget_soft', 'budget_hard', 'max_retries', 'pause_on_failed_shot'];
    const updates = [];
    const vals = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        if (f === 'mode' && !['AUTO', 'MANUAL'].includes(req.body[f])) continue;
        updates.push(`${f} = ?`);
        vals.push(req.body[f]);
      }
    }
    if (updates.length) {
      db.prepare(`UPDATE projects SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...vals, project.id);
    }
    res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) });
  });

  app.post('/api/projects/:id/open', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    setSetting(db, 'active_project_id', String(project.id));
    res.json({ ok: true, activeProjectId: project.id });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const r = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (Number(getSetting(db, 'active_project_id')) === Number(req.params.id)) setSetting(db, 'active_project_id', '');
    res.json({ ok: r.changes > 0 });
  });

  // ---------- full dashboard state ----------
  app.get('/api/projects/:id/state', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const shots = db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY ord').all(project.id);
    const shotIds = shots.map((s) => s.id);
    const inClause = shotIds.length ? shotIds.map(() => '?').join(',') : 'NULL';
    const candidates = shotIds.length
      ? db.prepare(`SELECT c.*, a.path AS asset_path FROM candidates c JOIN assets a ON a.id = c.asset_id WHERE c.shot_id IN (${inClause}) ORDER BY c.id`).all(...shotIds)
      : [];
    const approvals = db.prepare(
      "SELECT * FROM approvals WHERE project_id = ? AND status IN ('pending','paused') ORDER BY id DESC"
    ).all(project.id);
    const jobs = db.prepare(
      "SELECT * FROM jobs WHERE project_id = ? ORDER BY id DESC LIMIT 100"
    ).all(project.id);
    const assets = db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY id DESC').all(project.id);
    const refs = db.prepare('SELECT * FROM refs WHERE project_id = ? ORDER BY id DESC').all(project.id);
    const now = Date.now();
    res.json({
      project, shots, candidates, approvals, jobs, assets, refs,
      settings: allSettings(db),
      serverTime: now,
      queue: {
        now: jobs.filter((j) => j.status === 'NOW'),
        next: jobs.filter((j) => j.status === 'QUEUED').slice(-1)[0] || null,
        queued: jobs.filter((j) => j.status === 'QUEUED'),
        complete: jobs.filter((j) => j.status === 'COMPLETE'),
        failed: jobs.filter((j) => j.status === 'FAILED'),
        cancelled: jobs.filter((j) => j.status === 'CANCELLED'),
      },
    });
  });

  // ---------- shots ----------
  app.post('/api/projects/:id/shots', asyncH(async (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const { title, description = '', duration_seconds = 4 } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
    const maxOrd = db.prepare('SELECT COALESCE(MAX(ord),0) AS m FROM shots WHERE project_id = ?').get(project.id).m;
    const info = db.prepare(
      'INSERT INTO shots (project_id, ord, title, description, duration_seconds) VALUES (?,?,?,?,?)'
    ).run(project.id, maxOrd + 1, String(title).trim(), String(description), Number(duration_seconds) || 4);
    const shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ shot });
  }));

  app.patch('/api/shots/:id', (req, res) => {
    const shot = db.prepare('SELECT * FROM shots WHERE id = ?').get(req.params.id);
    if (!shot) return res.status(404).json({ error: 'not found' });
    const fields = ['title', 'description', 'duration_seconds', 'image_prompt', 'video_prompt', 'status'];
    const updates = [];
    const vals = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (updates.length) {
      db.prepare(`UPDATE shots SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, shot.id);
    }
    res.json({ shot: db.prepare('SELECT * FROM shots WHERE id = ?').get(shot.id) });
  });

  app.delete('/api/shots/:id', (req, res) => {
    const r = db.prepare('DELETE FROM shots WHERE id = ?').run(req.params.id);
    res.json({ ok: r.changes > 0 });
  });

  app.post('/api/projects/:id/shots/reorder', (req, res) => {
    const { shotIds } = req.body || {};
    if (!Array.isArray(shotIds)) return res.status(400).json({ error: 'shotIds array required' });
    const tx = db.transaction(() => {
      shotIds.forEach((id, i) => {
        db.prepare('UPDATE shots SET ord = ? WHERE id = ? AND project_id = ?').run(i + 1, id, req.params.id);
      });
    });
    tx();
    res.json({ shots: db.prepare('SELECT * FROM shots WHERE project_id = ? ORDER BY ord').all(req.params.id) });
  });

  app.post('/api/shots/:id/start', (req, res) => {
    try {
      res.json(engine.startShot(Number(req.params.id)));
    } catch (e) { res.status(404).json({ error: e.message }); }
  });

  app.post('/api/projects/:id/start', (req, res) => {
    try {
      res.json(engine.startProject(Number(req.params.id)));
    } catch (e) { res.status(404).json({ error: e.message }); }
  });

  // ---------- approvals / review ----------
  app.get('/api/approvals', (req, res) => {
    res.json({ approvals: db.prepare("SELECT * FROM approvals WHERE status IN ('pending','paused') ORDER BY id").all() });
  });

  app.post('/api/approvals/:id/select', (req, res) => {
    const { candidateId } = req.body || {};
    if (!candidateId) return res.status(400).json({ error: 'candidateId required' });
    res.json(engine.selectCandidate(Number(req.params.id), Number(candidateId)));
  });
  app.post('/api/approvals/:id/approve', (req, res) => {
    res.json(engine.approve(Number(req.params.id), { candidateId: req.body?.candidateId ?? null }));
  });
  app.post('/api/approvals/:id/reject', (req, res) => res.json(engine.reject(Number(req.params.id))));
  app.post('/api/approvals/:id/pause', (req, res) => res.json(engine.pauseApproval(Number(req.params.id))));
  app.post('/api/approvals/:id/resume', (req, res) => res.json(engine.resumeApproval(Number(req.params.id))));

  // ---------- queue ----------
  app.get('/api/queue', (req, res) => {
    const jobs = db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 200').all();
    res.json({
      now: jobs.filter((j) => j.status === 'NOW'),
      next: jobs.filter((j) => j.status === 'QUEUED').slice(-1)[0] || null,
      queued: jobs.filter((j) => j.status === 'QUEUED'),
      complete: jobs.filter((j) => j.status === 'COMPLETE'),
      failed: jobs.filter((j) => j.status === 'FAILED'),
      cancelled: jobs.filter((j) => j.status === 'CANCELLED'),
    });
  });

  app.post('/api/jobs/:id/retry', (req, res) => res.json(engine.retryJob(Number(req.params.id))));
  app.post('/api/jobs/:id/cancel', (req, res) => res.json(engine.cancelJob(Number(req.params.id))));

  // ---------- global controls ----------
  app.get('/api/control', (req, res) => {
    res.json({
      globalStop: getSetting(db, 'global_stop') === '1',
      automationPaused: getSetting(db, 'automation_paused') === '1',
    });
  });
  app.post('/api/control/stop', (req, res) => {
    setSetting(db, 'global_stop', '1');
    res.json({ ok: true, globalStop: true });
  });
  app.post('/api/control/resume', (req, res) => {
    setSetting(db, 'global_stop', '0');
    setSetting(db, 'automation_paused', '0');
    res.json({ ok: true, globalStop: false, automationPaused: false });
  });
  app.post('/api/control/pause', (req, res) => {
    setSetting(db, 'automation_paused', '1');
    res.json({ ok: true, automationPaused: true });
  });
  app.post('/api/control/unpause', (req, res) => {
    setSetting(db, 'automation_paused', '0');
    res.json({ ok: true, automationPaused: false });
  });

  // ---------- settings / agents / history ----------
  app.get('/api/settings', (req, res) => res.json({ settings: allSettings(db) }));
  app.patch('/api/settings', (req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) setSetting(db, k, v);
    res.json({ settings: allSettings(db) });
  });
  app.get('/api/agents', (req, res) => res.json({ agents: listAgents() }));

  app.get('/api/history', (req, res) => {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = projectId
      ? db.prepare('SELECT * FROM history WHERE project_id = ? ORDER BY id DESC LIMIT 200').all(projectId)
      : db.prepare('SELECT * FROM history ORDER BY id DESC LIMIT 200').all();
    res.json({ history: rows });
  });

  // ---------- references ----------
  app.post('/api/projects/:id/refs', (req, res) => {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'not found' });
    const { name, kind = 'note', content = '', shot_id = null } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    let storedPath = null;
    if (kind === 'file' && content) {
      const rel = `${project.slug}/refs/${Date.now()}-${String(name).replace(/[^a-z0-9.\-_]+/gi, '_')}.txt`;
      const abs = path.join(mediaDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(content));
      storedPath = rel;
    }
    const info = db.prepare('INSERT INTO refs (project_id, shot_id, name, kind, content, path) VALUES (?,?,?,?,?,?)')
      .run(project.id, shot_id, String(name), ['note', 'link', 'file'].includes(kind) ? kind : 'note', String(content), storedPath);
    res.status(201).json({ ref: db.prepare('SELECT * FROM refs WHERE id = ?').get(info.lastInsertRowid) });
  });

  app.delete('/api/refs/:id', (req, res) => {
    const r = db.prepare('DELETE FROM refs WHERE id = ?').run(req.params.id);
    res.json({ ok: r.changes > 0 });
  });

  // ---------- assets ----------
  app.get('/api/assets', (req, res) => {
    const projectId = req.query.project_id ? Number(req.query.project_id) : null;
    const rows = projectId
      ? db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY id DESC').all(projectId)
      : db.prepare('SELECT * FROM assets ORDER BY id DESC LIMIT 500').all();
    res.json({ assets: rows.map((a) => ({ ...a, meta: JSON.parse(a.meta || '{}') })) });
  });

  // ---------- static: media + production build ----------
  app.use('/media', express.static(mediaDir, { fallthrough: true, maxAge: '1h' }));
  if (distDir && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return next();
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // error handler
  app.use((err, req, res, _next) => {
    console.error('[api]', err);
    res.status(500).json({ error: err.message || 'internal error' });
  });

  return app;
}
