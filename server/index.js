// Hermes Video Studio server entry.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createEngine } from './worker.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DATA_DIR = process.env.HVS_DATA_DIR || path.join(ROOT, 'data');
const MEDIA_DIR = process.env.HVS_MEDIA_DIR || path.join(ROOT, 'media');
const DB_PATH = process.env.HVS_DB_PATH || path.join(DATA_DIR, 'hvs.db');
const PORT = Number(process.env.PORT || process.env.HVS_PORT || 4174);
const DIST_DIR = path.join(ROOT, 'dist');

const db = openDb(DB_PATH);
const engine = createEngine({ db, mediaDir: MEDIA_DIR });
const app = createApp({ db, engine, mediaDir: MEDIA_DIR, distDir: DIST_DIR });

engine.start();

app.listen(PORT, () => {
  console.log(`Hermes Video Studio listening on http://localhost:${PORT}`);
  console.log(`  db:    ${DB_PATH}`);
  console.log(`  media: ${MEDIA_DIR}`);
  console.log(`  dist:  ${fs.existsSync(DIST_DIR) ? DIST_DIR : '(not built — run npm run build)'}`);
});
