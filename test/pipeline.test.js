import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, seedProject, seedShot, runUntil } from './helpers.js';
import { openDb, setSetting, getSetting } from '../server/db.js';
import { runAgent } from '../server/agent.js';
import { mockImageProvider, mockVideoProvider } from '../server/providers.js';

let world;
beforeEach(() => { world = makeWorld(); });
afterEach(() => world.cleanup());

async function driveTicks(engine, n = 200) {
  for (let i = 0; i < n; i++) {
    await engine.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('mock provider adapters', () => {
  it('image provider lifecycle: generate → processing → succeeded, with cost', async () => {
    const { providerJobId } = mockImageProvider.generateImage({ prompt: 'x' }, { latencyMs: 30 });
    expect(mockImageProvider.getJobStatus(providerJobId).status).toBe('processing');
    await new Promise((r) => setTimeout(r, 45));
    expect(mockImageProvider.getJobStatus(providerJobId).status).toBe('succeeded');
    expect(mockImageProvider.getCost()).toBeGreaterThan(0);
    const v = mockVideoProvider.generateVideo({ prompt: 'y' }, { latencyMs: 30 });
    expect(v.providerJobId).toBeTruthy();
    expect(mockVideoProvider.getCost()).toBeGreaterThan(mockImageProvider.getCost());
  });

  it('runAgent scores candidates and picks a winner deterministically', async () => {
    const r = await runAgent('candidate-scout', { candidateIds: [11, 22, 33], prompt: 'storm' });
    expect(r.scored).toHaveLength(3);
    expect(r.selectedId).toBe(r.scored[0].id);
    const r2 = await runAgent('candidate-scout', { candidateIds: [11, 22, 33], prompt: 'storm' });
    expect(r2.selectedId).toBe(r.selectedId); // deterministic
    await expect(runAgent('nope', {})).rejects.toThrow('unknown agent');
  });
});

describe('AUTO pipeline', () => {
  it('runs shot end-to-end unattended: image review → video review → complete', async () => {
    const p = seedProject(world.db, { mode: 'AUTO', countdown: 1 });
    const shot = seedShot(world.db, p.id);
    world.engine.startProject(p.id);
    const engine = world.engine;
    const done = await runUntil(async () => {
      await engine.tick();
      const s = world.db.prepare('SELECT * FROM shots WHERE id = ?').get(shot.id);
      return s.status === 'complete' ? s : null;
    }, { timeoutMs: 15000 });
    expect(done.approved_image_asset_id).toBeTruthy();
    expect(done.approved_video_asset_id).toBeTruthy();

    // media files written to disk
    const assets = world.db.prepare('SELECT * FROM assets WHERE project_id = ?').all(p.id);
    expect(assets.length).toBeGreaterThanOrEqual(5); // 3 images + 2 videos
    for (const a of assets) {
      expect(fs.existsSync(path.join(world.mediaDir, a.path))).toBe(true);
    }
    // spend tracked
    const proj = world.db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
    expect(proj.spend).toBeCloseTo(0.02 + 0.1, 5);
    // project complete
    expect(proj.stage).toBe('complete');
    // AI selected candidate was approved
    const approved = world.db.prepare("SELECT * FROM candidates WHERE status = 'approved'").all();
    expect(approved.length).toBe(2);
  });

  it('multi-shot project advances sequentially through the storyboard', async () => {
    const p = seedProject(world.db, { mode: 'AUTO', countdown: 1 });
    seedShot(world.db, p.id, 1, 'One');
    seedShot(world.db, p.id, 2, 'Two');
    world.engine.startProject(p.id);
    await runUntil(async () => {
      await world.engine.tick();
      const proj = world.db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
      return proj.stage === 'complete' ? proj : null;
    }, { timeoutMs: 30000 });
    const shots = world.db.prepare('SELECT * FROM shots ORDER BY ord').all();
    expect(shots.every((s) => s.status === 'complete')).toBe(true);
  });
});

describe('MANUAL review flow', () => {
  it('pauses at image review until human approves; override changes approved candidate', async () => {
    const p = seedProject(world.db, { mode: 'MANUAL', countdown: 1 });
    const shot = seedShot(world.db, p.id);
    world.engine.startProject(p.id);

    const approval = await runUntil(async () => {
      await world.engine.tick();
      return world.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND kind = 'image'").get();
    });
    // even after waiting well past any countdown, MANUAL must not auto-approve
    await new Promise((r) => setTimeout(r, 1200));
    await driveTicks(world.engine, 5);
    let s = world.db.prepare('SELECT * FROM shots WHERE id = ?').get(shot.id);
    expect(s.status).toBe('image_review');

    // override selection to a non-AI candidate
    const cands = world.db.prepare("SELECT * FROM candidates WHERE shot_id = ? AND kind = 'image' AND status = 'pending'").all(shot.id);
    const ai = cands.find((c) => c.ai_selected);
    const other = cands.find((c) => !c.ai_selected);
    const sel = await request(world.app).post(`/api/approvals/${approval.id}/select`).send({ candidateId: other.id });
    expect(sel.body.ok).toBe(true);

    const ok = await request(world.app).post(`/api/approvals/${approval.id}/approve`);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.candidateId).toBe(other.id);
    expect(ok.body.candidateId).not.toBe(ai.id);
    s = world.db.prepare('SELECT * FROM shots WHERE id = ?').get(shot.id);
    expect(['video_generating', 'video_review', 'complete']).toContain(s.status);
  });

  it('reject & regenerate produces a new round of candidates', async () => {
    const p = seedProject(world.db, { mode: 'MANUAL' });
    const shot = seedShot(world.db, p.id);
    world.engine.startProject(p.id);
    const approval = await runUntil(async () => {
      await world.engine.tick();
      return world.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND kind = 'image'").get();
    });
    const rej = await request(world.app).post(`/api/approvals/${approval.id}/reject`);
    expect(rej.body.ok).toBe(true);

    const round2 = await runUntil(async () => {
      await world.engine.tick();
      const rows = world.db.prepare("SELECT * FROM candidates WHERE shot_id = ? AND kind = 'image' AND round = 2 AND status = 'pending'").all(shot.id);
      return rows.length ? rows : null;
    }, { timeoutMs: 15000 });
    expect(round2.length).toBeGreaterThan(0);
  });

  it('approval countdown pause/resume works in AUTO mode', async () => {
    const p = seedProject(world.db, { mode: 'AUTO', countdown: 5 });
    const shot = seedShot(world.db, p.id);
    world.engine.startProject(p.id);
    const approval = await runUntil(async () => {
      await world.engine.tick();
      return world.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").get();
    });
    const pause = await request(world.app).post(`/api/approvals/${approval.id}/pause`);
    expect(pause.body.ok).toBe(true);
    // wait past the original deadline — must not auto-approve while paused
    await new Promise((r) => setTimeout(r, 300));
    await driveTicks(world.engine, 3);
    let a = world.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id);
    expect(a.status).toBe('paused');
    const resume = await request(world.app).post(`/api/approvals/${approval.id}/resume`);
    expect(resume.body.ok).toBe(true);
    a = world.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approval.id);
    expect(a.status).toBe('pending');
    expect(a.deadline).toBeGreaterThan(Date.now());
  });
});

describe('budgets, retries, failures', () => {
  it('hard budget blocks further automated generation', async () => {
    const p = seedProject(world.db, { mode: 'AUTO', countdown: 1 });
    seedShot(world.db, p.id);
    // hard budget below the cost of one image generation
    world.db.prepare('UPDATE projects SET budget_hard = 0.01, budget_soft = 0.005 WHERE id = ?').run(p.id);
    world.engine.startProject(p.id);
    await driveTicks(world.engine, 20);
    const jobs = world.db.prepare('SELECT * FROM jobs').all();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.status === 'QUEUED')).toBe(true);
    expect(world.db.prepare('SELECT spend FROM projects WHERE id = ?').get(p.id).spend).toBe(0);
    const hist = world.db.prepare("SELECT * FROM history WHERE detail LIKE '%hard budget%'").all();
    expect(hist.length).toBeGreaterThan(0);
  });

  it('failed generations retry up to max_retries then fail the shot and pause automation', async () => {
    const p = seedProject(world.db, { mode: 'AUTO', countdown: 1 });
    const shot = seedShot(world.db, p.id);
    world.db.prepare('UPDATE projects SET max_retries = 2, pause_on_failed_shot = 1 WHERE id = ?').run(p.id);
    // force failure via payload forceFail — enqueue directly
    world.engine.enqueueJob({ shotId: shot.id, kind: 'image', round: 1, payload: { forceFail: true } });
    await runUntil(async () => {
      await world.engine.tick();
      const s = world.db.prepare('SELECT * FROM shots WHERE id = ?').get(shot.id);
      return s.status === 'failed' ? s : null;
    }, { timeoutMs: 15000 });
    expect(getSetting(world.db, 'automation_paused')).toBe('1');
    const failedJobs = world.db.prepare("SELECT * FROM jobs WHERE status = 'FAILED'").all();
    expect(failedJobs.length).toBe(2); // initial + 1 retry, max_retries = 2 attempts total
  });
});

describe('persistence', () => {
  it('state survives closing and reopening the database', async () => {
    const p = seedProject(world.db, { mode: 'MANUAL' });
    const shot = seedShot(world.db, p.id, 1, 'Persist me');
    setSetting(world.db, 'active_project_id', String(p.id));
    const dbPath = world.dbPath;
    world.db.close();

    const db2 = openDb(dbPath);
    const proj = db2.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
    expect(proj.name).toBe('Test Project');
    expect(proj.mode).toBe('MANUAL');
    const shots = db2.prepare('SELECT * FROM shots WHERE project_id = ?').all(p.id);
    expect(shots).toHaveLength(1);
    expect(shots[0].title).toBe('Persist me');
    expect(getSetting(db2, 'active_project_id')).toBe(String(p.id));
    db2.close();
    // reopen for cleanup safety
    world.db = openDb(dbPath);
  });
});
