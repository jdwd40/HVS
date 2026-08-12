import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderImageSvg, renderVideoSvg, renderVideoMp4, mediaAbsPath } from '../server/media.js';

describe('mock media generation', () => {
  it('renders deterministic SVG images', () => {
    const a = renderImageSvg({ prompt: 'neon rain', label: 'Shot 1', seedText: 'x' });
    const b = renderImageSvg({ prompt: 'neon rain', label: 'Shot 1', seedText: 'x' });
    expect(a).toBe(b);
    expect(a).toContain('<svg');
  });

  it('renders a real playable MP4 via ffmpeg (or skips cleanly)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvs-media-'));
    const abs = mediaAbsPath(dir, 'v/test.mp4');
    const ok = renderVideoMp4(abs, { prompt: 'city flyover', label: 'Shot 1 · Video 1', seedText: 's', duration: 2 });
    if (ok) {
      const buf = fs.readFileSync(abs);
      expect(buf.length).toBeGreaterThan(1000);
      expect(buf.slice(4, 8).toString()).toBe('ftyp'); // valid mp4 container
    } else {
      // ffmpeg unavailable: fallback SVG must still work
      const svg = renderVideoSvg({ prompt: 'city flyover', label: 'Shot 1', seedText: 's', duration: 2 });
      expect(svg).toContain('<svg');
      expect(svg).toContain('animate');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
