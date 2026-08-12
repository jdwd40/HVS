// Smoke test: exercises health + key API endpoints against a running server.
// Usage: BASE=http://localhost:4174 node scripts/smoke.js
const BASE = process.env.BASE || 'http://localhost:4174';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const j = async (url, opts = {}) => {
  const res = await fetch(BASE + url, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. health
const health = await j('/api/health');
ok('GET /api/health', health.status === 200 && health.body.ok === true);

// 2. SPA served
const spa = await fetch(BASE + '/');
const html = await spa.text();
ok('GET / serves built app', spa.status === 200 && html.includes('id="root"'));

// 3. project lifecycle
const created = await j('/api/projects', { method: 'POST', body: { name: `Smoke ${Date.now()}` } });
ok('POST /api/projects', created.status === 201 && created.body.project.mode === 'AUTO');
const pid = created.body.project.id;

const shot = await j(`/api/projects/${pid}/shots`, { method: 'POST', body: { title: 'Cold open', description: 'Rain on neon glass' } });
ok('POST shots', shot.status === 201);
const shot2 = await j(`/api/projects/${pid}/shots`, { method: 'POST', body: { title: 'Rooftop run' } });
ok('POST second shot', shot2.status === 201);

// 4. settings: speed up mocks for smoke
await j('/api/settings', { method: 'PATCH', body: { mock_latency_ms: 300, tick_ms: 100 } });
await j(`/api/projects/${pid}`, { method: 'PATCH', body: { countdown_seconds: 2 } });

// 5. start production, wait for full completion (AUTO, unattended)
await j(`/api/projects/${pid}/start`, { method: 'POST' });
let state;
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  await sleep(500);
  state = (await j(`/api/projects/${pid}/state`)).body;
  if (state.project.stage === 'complete') break;
}
ok('AUTO production runs to completion', state.project.stage === 'complete', `stage=${state.project.stage}`);
ok('all shots complete', state.shots.every((s) => s.status === 'complete'));
ok('spend tracked', state.project.spend > 0, `spend=$${state.project.spend.toFixed(2)}`);
ok('assets generated', state.assets.length >= 10, `${state.assets.length} assets`);
ok('jobs COMPLETE', state.jobs.some((jb) => jb.status === 'COMPLETE'));

// 6. media served (image SVG + playable MP4 video)
const imgAsset = state.assets.find((a) => a.type === 'image');
const media = await fetch(`${BASE}/media/${imgAsset.path}`);
ok('GET /media/<image>', media.status === 200 && (await media.text()).includes('<svg'));
const vidAsset = state.assets.find((a) => a.type === 'video');
const vres = await fetch(`${BASE}/media/${vidAsset.path}`);
const vbuf = Buffer.from(await vres.arrayBuffer());
const isMp4 = vidAsset.path.endsWith('.mp4') && vbuf.slice(4, 8).toString() === 'ftyp';
const isSvgFallback = vidAsset.path.endsWith('.svg') && vbuf.toString('utf8', 0, 200).includes('<svg');
ok('GET /media/<video> playable mock media', vres.status === 200 && (isMp4 || isSvgFallback), `${vidAsset.path} (${vbuf.length} bytes)`);

// 7. queue + history + control endpoints
const queue = await j('/api/queue');
ok('GET /api/queue', queue.status === 200 && Array.isArray(queue.body.complete));
const hist = await j(`/api/history?project_id=${pid}`);
ok('GET /api/history', hist.status === 200 && hist.body.history.length > 0);
const ctl = await j('/api/control/stop', { method: 'POST' });
ok('global STOP', ctl.body.globalStop === true);
await j('/api/control/resume', { method: 'POST' });
ok('control resume', true);

// 8. refs + duplicate protection
const ref = await j(`/api/projects/${pid}/refs`, { method: 'POST', body: { name: 'style guide', kind: 'note', content: 'teal/orange' } });
ok('POST refs', ref.status === 201);

// 9. cleanup smoke project
const del = await j(`/api/projects/${pid}`, { method: 'DELETE' });
ok('DELETE project', del.body.ok === true);

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
