# Hermes Video Studio

A standalone, local-first **AI video production console** (MVP). Dark, cinematic
single-page app for taking a project from storyboard to finished mock video —
with a worker engine that generates image/video candidates, runs timed review
windows, and advances shots automatically.

**Mock providers only.** No paid APIs are ever called; no credits can be
consumed. All media is generated locally and deterministically (SVG images,
real MP4 videos via ffmpeg when available).

## Stack

- Frontend: React 18 + Vite (production build in `dist/`, served by Express)
- Backend: Node + Express, better-sqlite3 (WAL)
- Media: local filesystem under `media/` (deterministic mock assets)
- Tests: vitest + supertest (22 tests, no network, no paid APIs)

## Quick start

```bash
npm install
npm run build      # production React build -> dist/
npm start          # serves UI + API on http://localhost:4174
```

Dev mode (hot reload, API proxied to the backend):

```bash
npm run dev:server &   # API on :4174
npm run dev            # Vite on :5173
```

## Commands

| Command            | Purpose                                      |
|--------------------|----------------------------------------------|
| `npm start`        | Production server (UI + API), port 4174      |
| `npm run build`    | Vite production build                        |
| `npm test`         | Full test suite (unit + integration)         |
| `npm run smoke`    | Smoke test against a running server          |
| `npm run dev`      | Vite dev server (proxies /api and /media)    |

Port: **4174** by default (`PORT` or `HVS_PORT` env overrides).
Health endpoint: `GET /api/health` → `{"ok":true,...}`.

## Environment variables

- `PORT` / `HVS_PORT` — listen port (default 4174)
- `HVS_DATA_DIR` — SQLite directory (default `./data`)
- `HVS_DB_PATH` — full SQLite path (default `$HVS_DATA_DIR/hvs.db`)
- `HVS_MEDIA_DIR` — media root served at `/media/` (default `./media`)

## systemd (user service)

Template at `deploy/hvs.service`:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/hvs.service ~/.config/systemd/user/hvs.service
systemctl --user daemon-reload
systemctl --user enable --now hvs
systemctl --user status hvs      # start|stop|restart
journalctl --user -u hvs -f      # logs
```

## Concepts

- **Projects** — AUTO (default) or MANUAL mode, per-project countdown
  (default 5s), soft/hard budgets, max retries, pause-on-failure.
- **Shots** — ordered storyboard cards; title/description/duration prompts;
  statuses: `draft → image_generating → image_review → video_generating →
  video_review → complete` (or `failed`).
- **Review** — each generation round produces candidates scored by the
  `candidate-scout` agent; the top pick is highlighted **AI SELECTED**.
  In AUTO a visible countdown auto-approves the current selection
  (unattended); in MANUAL the worker waits. You can pause/resume the
  countdown, click another candidate to override the selection (resets the
  countdown), **OK now**, or **Reject & regenerate** (next round).
- **Queue** — jobs are `NOW / NEXT / QUEUED / COMPLETE / FAILED / CANCELLED`
  with pause/resume (global automation pause), retry, cancel, and duplicate
  protection (one active job per shot+kind+round; unique dedupe keys).
- **Budgets** — every completed generation records provider cost; soft budget
  tints the meter, hard budget blocks further automated generation.
- **Safety** — global STOP freezes all automation; automation pause stops new
  queue work while preserving state; failed shots exhaust `max_retries` then
  pause automation (configurable). No runaway generation: one job runs at a
  time.
- **Persistence** — everything lives in SQLite (`data/hvs.db`) + `media/`;
  full state survives browser and server restarts.

## Architecture

```
server/
  index.js      entry: opens db, starts engine, serves Express + dist/
  app.js        REST API + static hosting (/api/*, /media/*, SPA)
  db.js         schema + settings (projects, shots, refs, assets,
                candidates, jobs, approvals, settings, history)
  worker.js     engine: queue, generation, countdowns, approvals, budgets,
                retries, pipeline advancement
  providers.js  provider adapters (generateImage/generateVideo/getJobStatus/
                getCost) — MOCK implementations only
  agent.js      generic agent adapter: runAgent(name, payload)
  media.js      deterministic SVG images + MP4 mock videos (ffmpeg, SVG fallback)
client/src/     React console: sidebar projects + master control, storyboard,
                review panel (countdown ring, candidate grid), queue, library
                (assets / references / history)
test/           vitest + supertest suites (api, pipeline, media)
scripts/smoke.js  end-to-end smoke against a running server
deploy/hvs.service  systemd user unit template
```

## Provider adapters

All provider access goes through one interface:

```js
generateImage(payload, opts) -> { providerJobId }
generateVideo(payload, opts) -> { providerJobId }
getJobStatus(providerJobId)  -> { status: 'processing'|'succeeded'|'failed', ... }
getCost()                    -> number (USD per generation)
```

Only `mock-image` and `mock-video` exist. Real providers must never be wired
in without an explicit request — the budget/stop machinery assumes cost data
from `getCost()`.

## Verification

- `npm test` — 22 tests: project/shot CRUD, reorder, refs, settings/control,
  provider lifecycle, agent scoring, AUTO end-to-end unattended runs,
  multi-shot sequential progression, MANUAL review hold, selection override,
  reject/regenerate rounds, countdown pause/resume, hard-budget block,
  retry exhaustion + auto-pause, duplicate-job protection, global STOP,
  queue retry/cancel, DB persistence across reopen, MP4/SVG media validity.
- `npm run smoke` — 18 checks against a live server: health, SPA, project +
  shot creation, full AUTO production to completion, spend tracking, asset
  generation, SVG + playable MP4 serving, queue/history/control/refs, delete.

## Limitations (MVP)

- Single user, no auth — intended for localhost / trusted network.
- One generation job runs at a time (by design: no runaway spend).
- MP4 mock videos require ffmpeg; without it, animated SVGs are used instead.
- Reference "file" attachments store pasted text, not binary uploads.
