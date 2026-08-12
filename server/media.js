// Mock media generation: deterministic SVG images and real MP4 mock videos
// (via ffmpeg when available, animated SVG fallback).
// No network, no paid providers — everything is generated locally.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

function hashSeed(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest();
}

function palette(seedBuf, n) {
  const colors = [];
  for (let i = 0; i < n; i++) {
    const h = seedBuf[i % seedBuf.length] * 1.41 + i * 47;
    colors.push(`hsl(${Math.floor(h % 360)}, 62%, ${34 + ((i * 13) % 30)}%)`);
  }
  return colors;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderImageSvg({ prompt, label, seedText, width = 640, height = 360 }) {
  const seed = hashSeed(seedText, prompt, label);
  const [c1, c2, c3, c4] = palette(seed, 4);
  const shapes = [];
  for (let i = 0; i < 6; i++) {
    const x = seed[(i * 3) % seed.length] % width;
    const y = seed[(i * 5 + 1) % seed.length] % height;
    const r = 24 + (seed[(i * 7 + 2) % seed.length] % 90);
    shapes.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${palette(seed, 8)[(i + 2) % 8]}" opacity="0.35"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#g)"/>
  ${shapes.join('\n  ')}
  <rect width="${width}" height="${height}" fill="black" opacity="0.18"/>
  <text x="24" y="${height - 58}" font-family="monospace" font-size="20" fill="#fff" opacity="0.95">${esc(label)}</text>
  <text x="24" y="${height - 30}" font-family="monospace" font-size="12" fill="#e6e6e6" opacity="0.8">${esc(prompt.slice(0, 72))}</text>
  <text x="${width - 24}" y="30" text-anchor="end" font-family="monospace" font-size="11" fill="${c4}">MOCK IMAGE</text>
</svg>`;
}

export function renderVideoSvg({ prompt, label, seedText, duration = 4, width = 640, height = 360 }) {
  const seed = hashSeed('video', seedText, prompt, label);
  const [c1, c2, c3] = palette(seed, 3);
  const dur = Math.max(1, duration);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${c1}"><animate attributeName="stop-color" values="${c1};${c2};${c1}" dur="${dur}s" repeatCount="indefinite"/></stop>
    <stop offset="1" stop-color="${c3}"><animate attributeName="stop-color" values="${c3};${c2};${c3}" dur="${dur}s" repeatCount="indefinite"/></stop>
  </linearGradient></defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle r="46" fill="#ffffff" opacity="0.5">
    <animate attributeName="cx" values="60;${width - 60};60" dur="${dur}s" repeatCount="indefinite"/>
    <animate attributeName="cy" values="${height / 2};${height / 3};${height / 2}" dur="${dur}s" repeatCount="indefinite"/>
  </circle>
  <rect width="${width}" height="${height}" fill="black" opacity="0.15"/>
  <text x="24" y="${height - 52}" font-family="monospace" font-size="20" fill="#fff">${esc(label)}</text>
  <text x="24" y="${height - 26}" font-family="monospace" font-size="12" fill="#eee" opacity="0.85">${esc(prompt.slice(0, 72))}</text>
  <text x="${width - 24}" y="30" text-anchor="end" font-family="monospace" font-size="11" fill="#fff">MOCK VIDEO ${dur}s</text>
</svg>`;
}

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

function findFont() {
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
}

// Render a real, playable MP4 mock video with ffmpeg (deterministic from seed).
// Returns true on success, false if ffmpeg is unavailable/fails.
export function renderVideoMp4(absPath, { prompt, label, seedText, duration = 4, width = 640, height = 360 }) {
  const seed = hashSeed('video', seedText, prompt, label);
  const hue = seed[0] % 360;
  const speed = 30 + (seed[1] % 60);
  const dur = Math.max(1, Math.min(30, duration));
  const font = findFont();
  const filters = [
    `hue=h=${hue}`,
    `drawbox=x='mod(t*${speed}\\,${width + 120})-120':y=${Math.floor(height / 2) - 40}:w=110:h=80:c=white@0.45:t=fill`,
  ];
  if (font) {
    const safeLabel = label.replace(/[:'\\]/g, ' ').slice(0, 60);
    const safeKind = 'MOCK VIDEO';
    filters.push(`drawtext=fontfile=${font}:text='${safeLabel}':x=24:y=${height - 64}:fontsize=22:fontcolor=white`);
    filters.push(`drawtext=fontfile=${font}:text='${safeKind}':x=${width - 150}:y=20:fontsize=13:fontcolor=white@0.8`);
  }
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=24:duration=${dur}`,
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      absPath,
    ], { timeout: 30000, stdio: 'pipe' });
    return fs.existsSync(absPath) && fs.statSync(absPath).size > 0;
  } catch {
    return false;
  }
}

export function writeMediaFile(mediaDir, relPath, content) {
  const abs = path.join(mediaDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return relPath;
}

export function mediaAbsPath(mediaDir, relPath) {
  const abs = path.join(mediaDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}
