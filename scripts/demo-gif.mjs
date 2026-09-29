#!/usr/bin/env node
/** Converts the recorded renter-journey webm into README-ready GIFs with the
 * two-pass palettegen/paletteuse workflow. Tuned for the product's flat
 * light-on-dark UI: low fps, bounded palette and coarse Bayer dithering keep
 * bodies of text legible at a fraction of the raw size.
 *
 * Usage: node scripts/demo-gif.mjs
 * Requires ffmpeg on PATH. Source defaults to the recorder's output location.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, relative, join, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'docs/implementation-notes/integration/local-product-assets/demo/archcore-renter-journey.webm');

if (!existsSync(SOURCE)) {
  console.error(`demo-gif: source not found: ${relative(ROOT, SOURCE)}`);
  console.error('demo-gif: run "npm run demo:record" first.');
  process.exit(1);
}

const FPS = 8;
const WIDTH = 760;
const COLORS = 128;
const DITHER = 5;

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error) {
  console.error("demo-gif: ffmpeg not found on PATH; install ffmpeg (e.g. 'apt install ffmpeg').");
  process.exit(1);
}

const base = SOURCE.replace(/\.webm$/, '');
const stem = basename(base);
const work = mkdtempSync(join(tmpdir(), 'demo-gif-'));
process.on('exit', () => rmSync(work, { recursive: true, force: true }));

const run = (args, label) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw Error(`${label} failed (exit ${r.status})`);
};

try {
  // Pass 1: bounded global palette derived from the source frames.
  run(['-i', SOURCE, '-vf', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=max_colors=${COLORS}:stats_mode=diff`, '-update', '1', join(work, 'palette.png')], 'palettegen');
  // Pass 2: replay through the palette with coarse dithering that suits flat UI colours.
  run(['-i', SOURCE, '-i', join(work, 'palette.png'), '-filter_complex', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=${DITHER}`, '-loop', '0', `${base}.gif`], 'paletteuse');
  // A trimmed intro clip for the top of a doc.
  run(['-ss', '0', '-t', '9', '-i', `${base}.gif`, '-c', 'copy', `${base}-clip.gif`], 'trim clip');

  const dir = resolve(base, '..');
  for (const name of readdirSync(dir).filter((f) => f.startsWith(`${stem}.gif`))) {
    console.log(`demo-gif: ${name} — ${Math.round(statSync(join(dir, name)).size / 1024)} KB`);
  }
  console.log(`demo-gif: done (${FPS}fps, ${WIDTH}px, ${COLORS} colours; source ${(statSync(SOURCE).size / 1048576).toFixed(1)} MB)`);
} catch (error) {
  console.error(`demo-gif: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
