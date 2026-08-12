// Worker engine: queue processing, mock generation, review countdowns,
// AUTO/MANUAL approvals, budgets, retries, duplicate protection.
import { getSetting, setSetting } from './db.js';
import { providerFor } from './providers.js';
import { runAgent } from './agent.js';
import { renderImageSvg, renderVideoSvg, renderVideoMp4, writeMediaFile, mediaAbsPath } from './media.js';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function createEngine({ db, mediaDir }) {
  const latencyMs = () => num(getSetting(db, 'mock_latency_ms'), 1200);
  const stopped = () => getSetting(db, 'global_stop') === '1';
  const paused = () => getSetting(db, 'automation_paused') === '1';

  const q = {
    project: (id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id),
    shot: (id) => db.prepare('SELECT * FROM shots WHERE id = ?').get(id),
    activeNowJob: () => db.prepare("SELECT * FROM jobs WHERE status = 'NOW' ORDER BY id LIMIT 1").get(),
    nextQueued: () => db.prepare("SELECT * FROM jobs WHERE status = 'QUEUED' ORDER BY id LIMIT 1").get(),
    activeJobFor: (shotId, kind) =>
      db.prepare("SELECT * FROM jobs WHERE shot_id = ? AND kind = ? AND status IN ('NOW','QUEUED')").get(shotId, kind),
    pendingApproval: (shotId, kind) =>
      db.prepare("SELECT * FROM approvals WHERE shot_id = ? AND kind = ? AND status IN ('pending','paused') ORDER BY id DESC LIMIT 1").get(shotId, kind),
    candidates: (shotId, kind, round) =>
      db.prepare('SELECT * FROM candidates WHERE shot_id = ? AND kind = ? AND round = ? ORDER BY id').all(shotId, kind, round),
  };

  function recordHistory({ projectId, shotId, jobId, kind, cost = 0, detail }) {
    db.prepare(
      'INSERT INTO history (project_id, shot_id, job_id, kind, provider, cost, detail) VALUES (?,?,?,?,?,?,?)'
    ).run(projectId, shotId, jobId, kind, 'mock', cost, detail || '');
  }

  // Enqueue a generation job with duplicate protection.
  // Returns { job, created } — created=false when an identical active job exists.
  function enqueueJob({ shotId, kind, round = 1, payload = {} }) {
    const shot = q.shot(shotId);
    if (!shot) throw new Error(`shot ${shotId} not found`);
    const existing = q.activeJobFor(shotId, kind);
    if (existing && existing.round === round) return { job: existing, created: false };

    const dedupeKey = `${shotId}:${kind}:r${round}:a0`;
    const found = db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(dedupeKey);
    if (found && ['NOW', 'QUEUED'].includes(found.status)) return { job: found, created: false };

    const info = db.prepare(
      `INSERT INTO jobs (project_id, shot_id, kind, status, round, dedupe_key, payload)
       VALUES (?,?,?, 'QUEUED', ?, ?, ?)`
    ).run(shot.project_id, shotId, kind, round, dedupeKey, JSON.stringify(payload));
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(info.lastInsertRowid);
    recordHistory({ projectId: shot.project_id, shotId, jobId: job.id, kind, detail: `enqueued ${kind} generation (round ${round})` });
    return { job, created: true };
  }

  function budgetBlocked(project, kind) {
    const provider = providerFor(kind);
    const cost = provider.getCost();
    return project.spend + cost > project.budget_hard;
  }

  // Start the next queued job if allowed. One NOW job at a time.
  function maybeStartNextJob() {
    if (stopped() || paused()) return;
    if (q.activeNowJob()) return;
    const job = q.nextQueued();
    if (!job) return;
    const project = q.project(job.project_id);
    if (!project) return;
    if (budgetBlocked(project, job.kind)) {
      recordHistory({ projectId: project.id, shotId: job.shot_id, jobId: job.id, kind: job.kind, detail: 'hard budget reached — automated generation blocked' });
      return; // leave QUEUED; budget gate keeps it from running away
    }
    const provider = providerFor(job.kind);
    const payload = JSON.parse(job.payload || '{}');
    const gen = job.kind === 'video'
      ? provider.generateVideo(payload, { latencyMs: latencyMs() })
      : provider.generateImage(payload, { latencyMs: latencyMs() });
    db.prepare("UPDATE jobs SET status = 'NOW', attempts = attempts + 1, provider_job_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(gen.providerJobId, job.id);
    db.prepare("UPDATE shots SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(job.kind === 'video' ? 'video_generating' : 'image_generating', job.shot_id);
    recordHistory({ projectId: project.id, shotId: job.shot_id, jobId: job.id, kind: job.kind, detail: `started ${job.kind} generation (attempt ${job.attempts + 1})` });
  }

  async function finishJobSuccess(job, result) {
    const shot = q.shot(job.shot_id);
    const project = q.project(job.project_id);
    const provider = providerFor(job.kind);
    const cost = provider.getCost();
    const count = job.kind === 'video'
      ? num(getSetting(db, 'video_candidates'), 2)
      : num(getSetting(db, 'image_candidates'), 3);

    const candIds = [];
    const tx = db.transaction(() => {
      db.prepare("UPDATE jobs SET status = 'COMPLETE', cost = ?, updated_at = datetime('now') WHERE id = ?").run(cost, job.id);
      db.prepare("UPDATE projects SET spend = spend + ?, updated_at = datetime('now') WHERE id = ?").run(cost, project.id);

      const prompt = job.kind === 'video'
        ? (shot.video_prompt || shot.description || shot.title)
        : (shot.image_prompt || shot.description || shot.title);
      for (let i = 0; i < count; i++) {
        const label = `Shot ${shot.ord} · ${job.kind === 'video' ? 'Video' : 'Image'} ${i + 1} · R${job.round}`;
        let rel;
        if (job.kind === 'video') {
          rel = `${project.slug}/shot-${shot.id}-video-r${job.round}-c${i + 1}.mp4`;
          const mp4Ok = renderVideoMp4(mediaAbsPath(mediaDir, rel), {
            prompt, label, seedText: `${shot.id}:${job.round}:${i}`, duration: shot.duration_seconds,
          });
          if (!mp4Ok) { // animated-SVG fallback when ffmpeg is unavailable
            rel = `${project.slug}/shot-${shot.id}-video-r${job.round}-c${i + 1}.svg`;
            writeMediaFile(mediaDir, rel, renderVideoSvg({ prompt, label, seedText: `${shot.id}:${job.round}:${i}`, duration: shot.duration_seconds }));
          }
        } else {
          rel = `${project.slug}/shot-${shot.id}-image-r${job.round}-c${i + 1}.svg`;
          writeMediaFile(mediaDir, rel, renderImageSvg({ prompt, label, seedText: `${shot.id}:${job.round}:${i}` }));
        }
        const a = db.prepare(
          'INSERT INTO assets (project_id, shot_id, type, path, meta) VALUES (?,?,?,?,?)'
        ).run(project.id, shot.id, job.kind, rel, JSON.stringify({ prompt, label, round: job.round, index: i + 1, provider: provider.name }));
        const c = db.prepare(
          'INSERT INTO candidates (shot_id, kind, asset_id, provider, round) VALUES (?,?,?,?,?)'
        ).run(shot.id, job.kind, a.lastInsertRowid, provider.name, job.round);
        candIds.push(Number(c.lastInsertRowid));
      }
      db.prepare("UPDATE shots SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(job.kind === 'video' ? 'video_review' : 'image_review', shot.id);
    });
    tx();

    // AI scoring/selection via the generic agent adapter.
    const prompt = job.kind === 'video'
      ? (shot.video_prompt || shot.description || shot.title)
      : (shot.image_prompt || shot.description || shot.title);
    const { scored, selectedId } = await runAgent('candidate-scout', { candidateIds: candIds, prompt });
    const updScore = db.prepare('UPDATE candidates SET ai_score = ?, ai_selected = ? WHERE id = ?');
    for (const s of scored) updScore.run(s.aiScore, s.id === selectedId ? 1 : 0, s.id);

    // Create the review approval with countdown deadline.
    const countdown = project.countdown_seconds;
    const auto = project.mode === 'AUTO' && !paused() && !stopped();
    db.prepare(
      `INSERT INTO approvals (project_id, shot_id, kind, round, status, countdown_seconds, deadline)
       VALUES (?,?,?,?, 'pending', ?, ?)`
    ).run(project.id, shot.id, job.kind, job.round, countdown, auto ? Date.now() + countdown * 1000 : null);

    recordHistory({ projectId: project.id, shotId: shot.id, jobId: job.id, kind: job.kind, cost, detail: `${job.kind} generation complete — ${count} candidates ready for review` });
  }

  function failJob(job, error) {
    const shot = q.shot(job.shot_id);
    const project = q.project(job.project_id);
    db.prepare("UPDATE jobs SET status = 'FAILED', error = ?, updated_at = datetime('now') WHERE id = ?").run(error, job.id);
    recordHistory({ projectId: job.project_id, shotId: job.shot_id, jobId: job.id, kind: job.kind, detail: `${job.kind} generation failed: ${error}` });

    if (job.attempts < project.max_retries) {
      const dedupeKey = `${job.shot_id}:${job.kind}:r${job.round}:a${job.attempts}`;
      db.prepare(
        `INSERT OR IGNORE INTO jobs (project_id, shot_id, kind, status, round, dedupe_key, payload, attempts)
         VALUES (?,?,?, 'QUEUED', ?, ?, ?, ?)`
      ).run(job.project_id, job.shot_id, job.kind, job.round, dedupeKey, job.payload, job.attempts);
      recordHistory({ projectId: job.project_id, shotId: job.shot_id, jobId: job.id, kind: job.kind, detail: `auto-retry queued (attempt ${job.attempts + 1}/${project.max_retries})` });
    } else {
      db.prepare("UPDATE shots SET status = 'failed', updated_at = datetime('now') WHERE id = ?").run(job.shot_id);
      if (project.pause_on_failed_shot) {
        setSetting(db, 'automation_paused', '1');
        recordHistory({ projectId: job.project_id, shotId: job.shot_id, jobId: job.id, kind: job.kind, detail: 'max retries exhausted — automation paused' });
      }
    }
  }

  async function pollNowJob() {
    const job = q.activeNowJob();
    if (!job || !job.provider_job_id) return;
    const provider = providerFor(job.kind);
    const res = provider.getJobStatus(job.provider_job_id);
    if (res.status === 'succeeded') await finishJobSuccess(job, res);
    else if (res.status === 'failed') failJob(job, res.error || 'provider failure');
  }

  function candidateForApproval(approval) {
    const cands = q.candidates(approval.shot_id, approval.kind, approval.round);
    return cands.find((c) => c.user_selected) || cands.find((c) => c.ai_selected) || cands[0] || null;
  }

  // Approve an approval (manual OK or AUTO countdown expiry).
  function approve(approvalId, { candidateId = null, auto = false } = {}) {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval || approval.status === 'approved') return { ok: false, reason: 'not pending' };
    const shot = q.shot(approval.shot_id);
    const project = q.project(approval.project_id);
    const chosen = candidateId
      ? db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId)
      : candidateForApproval(approval);
    if (!chosen) return { ok: false, reason: 'no candidate' };

    const tx = db.transaction(() => {
      db.prepare("UPDATE approvals SET status = 'approved', decided_candidate_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(chosen.id, approval.id);
      db.prepare("UPDATE candidates SET status = 'approved' WHERE id = ?").run(chosen.id);
      db.prepare("UPDATE candidates SET status = 'rejected' WHERE shot_id = ? AND kind = ? AND round = ? AND id != ?")
        .run(approval.shot_id, approval.kind, approval.round, chosen.id);
      if (approval.kind === 'image') {
        db.prepare('UPDATE shots SET approved_image_asset_id = ? WHERE id = ?').run(chosen.asset_id, shot.id);
      } else {
        db.prepare('UPDATE shots SET approved_video_asset_id = ? WHERE id = ?').run(chosen.asset_id, shot.id);
      }
    });
    tx();
    recordHistory({ projectId: project.id, shotId: shot.id, jobId: null, kind: approval.kind, detail: `${approval.kind} candidate #${chosen.id} approved${auto ? ' (AUTO countdown)' : ''}` });
    advanceAfterApproval(approval, project, shot);
    return { ok: true, candidateId: chosen.id };
  }

  function advanceAfterApproval(approval, project, shot) {
    if (approval.kind === 'image') {
      // proceed to video generation
      const { job } = enqueueJob({ shotId: shot.id, kind: 'video', round: approval.round });
      if (job) {
        db.prepare("UPDATE shots SET status = 'video_generating', updated_at = datetime('now') WHERE id = ?").run(shot.id);
      }
    } else {
      db.prepare("UPDATE shots SET status = 'complete', updated_at = datetime('now') WHERE id = ?").run(shot.id);
      // sequential storyboard progression: kick off the next draft shot
      const next = db.prepare(
        "SELECT * FROM shots WHERE project_id = ? AND status = 'draft' ORDER BY ord LIMIT 1"
      ).get(project.id);
      if (next && project.stage === 'production') {
        enqueueJob({ shotId: next.id, kind: 'image', round: 1 });
      } else if (!next) {
        const remaining = db.prepare(
          "SELECT COUNT(*) AS n FROM shots WHERE project_id = ? AND status NOT IN ('complete')"
        ).get(project.id).n;
        if (remaining === 0) {
          db.prepare("UPDATE projects SET stage = 'complete', updated_at = datetime('now') WHERE id = ?").run(project.id);
          recordHistory({ projectId: project.id, shotId: null, jobId: null, kind: null, detail: 'all shots complete — project finished' });
        }
      }
    }
  }

  // Reject an approval → candidates rejected, regenerate same kind, next round.
  function reject(approvalId) {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval || approval.status !== 'pending' && approval.status !== 'paused') return { ok: false, reason: 'not pending' };
    const shot = q.shot(approval.shot_id);
    const tx = db.transaction(() => {
      db.prepare("UPDATE approvals SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(approval.id);
      db.prepare("UPDATE candidates SET status = 'rejected' WHERE shot_id = ? AND kind = ? AND round = ?")
        .run(approval.shot_id, approval.kind, approval.round);
      db.prepare("UPDATE shots SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(approval.kind === 'video' ? 'video_generating' : 'image_generating', shot.id);
    });
    tx();
    enqueueJob({ shotId: shot.id, kind: approval.kind, round: approval.round + 1 });
    recordHistory({ projectId: approval.project_id, shotId: shot.id, jobId: null, kind: approval.kind, detail: `${approval.kind} review rejected — regenerating (round ${approval.round + 1})` });
    return { ok: true };
  }

  // User picks a different candidate: selection changes what gets approved.
  function selectCandidate(approvalId, candidateId) {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval || approval.status !== 'pending') return { ok: false, reason: 'not pending' };
    const cand = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
    if (!cand || cand.shot_id !== approval.shot_id || cand.kind !== approval.kind) return { ok: false, reason: 'bad candidate' };
    const tx = db.transaction(() => {
      db.prepare('UPDATE candidates SET user_selected = 0 WHERE shot_id = ? AND kind = ? AND round = ?')
        .run(approval.shot_id, approval.kind, approval.round);
      db.prepare('UPDATE candidates SET user_selected = 1 WHERE id = ?').run(candidateId);
      // reset countdown so the user has a full window after changing selection
      if (approval.deadline != null) {
        db.prepare('UPDATE approvals SET deadline = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .run(Date.now() + approval.countdown_seconds * 1000, approval.id);
      }
    });
    tx();
    return { ok: true };
  }

  function pauseApproval(approvalId) {
    const r = db.prepare("UPDATE approvals SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND status = 'pending'").run(approvalId);
    return { ok: r.changes > 0 };
  }

  function resumeApproval(approvalId) {
    const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
    if (!approval || approval.status !== 'paused') return { ok: false };
    db.prepare("UPDATE approvals SET status = 'pending', deadline = ?, updated_at = datetime('now') WHERE id = ?")
      .run(Date.now() + approval.countdown_seconds * 1000, approval.id);
    return { ok: true };
  }

  // AUTO mode countdown expiry.
  function processApprovals() {
    if (stopped() || paused()) return;
    const due = db.prepare(
      `SELECT a.*, p.mode AS project_mode FROM approvals a
       JOIN projects p ON p.id = a.project_id
       WHERE a.status = 'pending' AND a.deadline IS NOT NULL AND a.deadline <= ?`
    ).all(Date.now());
    for (const a of due) {
      if (a.project_mode !== 'AUTO') continue; // MANUAL: wait for human
      approve(a.id, { auto: true });
    }
  }

  // ---- queue controls ----
  function retryJob(jobId) {
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    if (!job || !['FAILED', 'CANCELLED'].includes(job.status)) return { ok: false, reason: 'not retryable' };
    if (q.activeJobFor(job.shot_id, job.kind)) return { ok: false, reason: 'active job already exists (duplicate prevented)' };
    const dedupeKey = `${job.shot_id}:${job.kind}:r${job.round}:m${jobId}`;
    const info = db.prepare(
      `INSERT INTO jobs (project_id, shot_id, kind, status, round, dedupe_key, payload)
       VALUES (?,?,?, 'QUEUED', ?, ?, ?)`
    ).run(job.project_id, job.shot_id, job.kind, job.round, dedupeKey, job.payload);
    return { ok: true, jobId: Number(info.lastInsertRowid) };
  }

  function cancelJob(jobId) {
    const r = db.prepare("UPDATE jobs SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ? AND status IN ('QUEUED','NOW')").run(jobId);
    return { ok: r.changes > 0 };
  }

  // Kick off a whole project: production stage + first shot's image job.
  function startProject(projectId) {
    const project = q.project(projectId);
    if (!project) throw new Error('project not found');
    db.prepare("UPDATE projects SET stage = 'production', updated_at = datetime('now') WHERE id = ?").run(projectId);
    const first = db.prepare("SELECT * FROM shots WHERE project_id = ? AND status = 'draft' ORDER BY ord LIMIT 1").get(projectId);
    if (first) enqueueJob({ shotId: first.id, kind: 'image', round: 1 });
    recordHistory({ projectId, shotId: first?.id ?? null, jobId: null, kind: null, detail: `project started (${project.mode} mode)` });
    return { ok: true };
  }

  function startShot(shotId) {
    const shot = q.shot(shotId);
    if (!shot) throw new Error('shot not found');
    if (shot.status !== 'draft' && shot.status !== 'failed') return { ok: false, reason: `shot is ${shot.status}` };
    if (shot.status === 'failed') {
      db.prepare("UPDATE shots SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(shotId);
    }
    enqueueJob({ shotId, kind: 'image', round: 1 });
    return { ok: true };
  }

  async function tick() {
    if (stopped()) return;
    await pollNowJob();
    maybeStartNextJob();
    processApprovals();
  }

  let timer = null;
  function start() {
    if (timer) return;
    const t = num(getSetting(db, 'tick_ms'), 400);
    timer = setInterval(() => { tick().catch((e) => console.error('[worker]', e)); }, t);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    tick, start, stop,
    enqueueJob, startProject, startShot,
    approve, reject, selectCandidate, pauseApproval, resumeApproval,
    retryJob, cancelJob,
  };
}
