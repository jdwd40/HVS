import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { makeWorld, seedProject, seedShot, runUntil } from './helpers.js';
import { getSetting } from '../server/db.js';

let world;
beforeEach(() => { world = makeWorld(); });
afterEach(() => world.cleanup());

describe('projects & shots API', () => {
  it('health endpoint responds', async () => {
    const res = await request(world.app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('creates, lists, opens, patches and deletes projects', async () => {
    const create = await request(world.app).post('/api/projects').send({ name: 'My Film' });
    expect(create.status).toBe(201);
    expect(create.body.project.mode).toBe('AUTO'); // AUTO is the default
    expect(create.body.project.countdown_seconds).toBe(5); // configurable default 5s
    const id = create.body.project.id;

    const list = await request(world.app).get('/api/projects');
    expect(list.body.projects.map((p) => p.id)).toContain(id);
    expect(list.body.activeProjectId).toBe(id);

    const patch = await request(world.app).patch(`/api/projects/${id}`).send({ mode: 'MANUAL', countdown_seconds: 9 });
    expect(patch.body.project.mode).toBe('MANUAL');
    expect(patch.body.project.countdown_seconds).toBe(9);

    const open = await request(world.app).post(`/api/projects/${id}/open`);
    expect(open.body.ok).toBe(true);

    const del = await request(world.app).del(`/api/projects/${id}`);
    expect(del.body.ok).toBe(true);
  });

  it('rejects nameless projects', async () => {
    const res = await request(world.app).post('/api/projects').send({});
    expect(res.status).toBe(400);
  });

  it('creates, edits, reorders and deletes shots', async () => {
    const p = seedProject(world.db);
    const a = (await request(world.app).post(`/api/projects/${p.id}/shots`).send({ title: 'A' })).body.shot;
    const b = (await request(world.app).post(`/api/projects/${p.id}/shots`).send({ title: 'B' })).body.shot;
    const c = (await request(world.app).post(`/api/projects/${p.id}/shots`).send({ title: 'C' })).body.shot;
    expect([a.ord, b.ord, c.ord]).toEqual([1, 2, 3]);

    const re = await request(world.app).post(`/api/projects/${p.id}/shots/reorder`).send({ shotIds: [c.id, a.id, b.id] });
    expect(re.body.shots.map((s) => s.title)).toEqual(['C', 'A', 'B']);

    const upd = await request(world.app).patch(`/api/shots/${a.id}`).send({ description: 'new desc', duration_seconds: 7 });
    expect(upd.body.shot.description).toBe('new desc');
    expect(upd.body.shot.duration_seconds).toBe(7);

    await request(world.app).del(`/api/shots/${b.id}`);
    const state = await request(world.app).get(`/api/projects/${p.id}/state`);
    expect(state.body.shots).toHaveLength(2);
  });

  it('manages references', async () => {
    const p = seedProject(world.db);
    const r = await request(world.app).post(`/api/projects/${p.id}/refs`).send({ name: 'Mood board', kind: 'link', content: 'https://example.com' });
    expect(r.status).toBe(201);
    const state = await request(world.app).get(`/api/projects/${p.id}/state`);
    expect(state.body.refs).toHaveLength(1);
    await request(world.app).del(`/api/refs/${r.body.ref.id}`);
    const state2 = await request(world.app).get(`/api/projects/${p.id}/state`);
    expect(state2.body.refs).toHaveLength(0);
  });

  it('exposes settings, control and agents', async () => {
    const s = await request(world.app).get('/api/settings');
    expect(s.body.settings.global_stop).toBe('0');
    const a = await request(world.app).get('/api/agents');
    expect(a.body.agents).toContain('candidate-scout');
    const stop = await request(world.app).post('/api/control/stop');
    expect(stop.body.globalStop).toBe(true);
    const ctl = await request(world.app).get('/api/control');
    expect(ctl.body.globalStop).toBe(true);
    await request(world.app).post('/api/control/resume');
    expect(getSetting(world.db, 'global_stop')).toBe('0');
  });
});

describe('queue controls & duplicate protection', () => {
  it('prevents duplicate active generation jobs for the same shot+kind', async () => {
    const p = seedProject(world.db);
    const shot = seedShot(world.db, p.id);
    const r1 = world.engine.enqueueJob({ shotId: shot.id, kind: 'image', round: 1 });
    const r2 = world.engine.enqueueJob({ shotId: shot.id, kind: 'image', round: 1 });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.job.id).toBe(r1.job.id);
    const count = world.db.prepare("SELECT COUNT(*) n FROM jobs WHERE shot_id = ? AND kind = 'image' AND status IN ('NOW','QUEUED')").get(shot.id).n;
    expect(count).toBe(1);
  });

  it('cancel moves QUEUED job to CANCELLED; retry re-queues a failed job', async () => {
    const p = seedProject(world.db);
    const shot = seedShot(world.db, p.id);
    const { job } = world.engine.enqueueJob({ shotId: shot.id, kind: 'image', round: 1 });
    const cancel = await request(world.app).post(`/api/jobs/${job.id}/cancel`);
    expect(cancel.body.ok).toBe(true);

    world.db.prepare("UPDATE jobs SET status = 'FAILED', error = 'x' WHERE id = ?").run(job.id);
    const retry = await request(world.app).post(`/api/jobs/${job.id}/retry`);
    expect(retry.body.ok).toBe(true);
    const q = await request(world.app).get('/api/queue');
    expect(q.body.queued.some((j) => j.shot_id === shot.id && j.kind === 'image')).toBe(true);
  });

  it('global STOP freezes the queue; resume restarts it', async () => {
    const p = seedProject(world.db);
    seedShot(world.db, p.id);
    await request(world.app).post('/api/control/stop');
    world.engine.startProject(p.id);
    for (let i = 0; i < 10; i++) await world.engine.tick();
    let jobs = world.db.prepare('SELECT * FROM jobs').all();
    expect(jobs.every((j) => j.status === 'QUEUED')).toBe(true); // nothing started

    await request(world.app).post('/api/control/resume');
    await runUntil(async () => {
      await world.engine.tick();
      return world.db.prepare("SELECT id FROM jobs WHERE status IN ('NOW','COMPLETE')").get();
    });
  });

  it('automation pause stops new queue work but preserves state', async () => {
    const p = seedProject(world.db);
    seedShot(world.db, p.id);
    await request(world.app).post('/api/control/pause');
    world.engine.startProject(p.id);
    for (let i = 0; i < 10; i++) await world.engine.tick();
    const jobs = world.db.prepare('SELECT * FROM jobs').all();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.status === 'QUEUED')).toBe(true);
    await request(world.app).post('/api/control/unpause');
    await runUntil(async () => {
      await world.engine.tick();
      return world.db.prepare("SELECT id FROM jobs WHERE status IN ('NOW','COMPLETE')").get();
    });
  });
});
