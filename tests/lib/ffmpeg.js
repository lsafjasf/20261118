// ffmpeg discovery. The Playwright-provided build is intentionally stripped
// (no lavfi, no chapter muxing, no PNG decoder), so fixture generation uses a
// full static build downloaded once into test-output/tools.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const TOOLS_DIR = join(ROOT, 'test-output', 'tools');
const STATIC_URL =
  'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';

export function findFfmpeg() {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? join(homedir(), '.cache', 'ms-playwright');
  const candidates = [
    join(cacheRoot, 'ffmpeg-1013', 'ffmpeg-linux'),
    join(cacheRoot, 'ffmpeg-1012', 'ffmpeg-linux'),
    join(cacheRoot, 'ffmpeg-1011', 'ffmpeg-linux'),
    process.env.FFMPEG_PATH
  ].filter(Boolean);
  const found = candidates.find((path) => path && existsSync(path));
  if (!found) {
    throw new Error(
      `ffmpeg not found. Run "npx playwright-core install chromium" or set FFMPEG_PATH. Tried: ${candidates.join(', ')}`
    );
  }
  return found;
}

function candidateFullFfmpegPaths() {
  return [
    process.env.FFMPEG_FULL_PATH,
    join(TOOLS_DIR, 'ffmpeg'),
    '/tmp/ffmpeg-7.0.2-amd64-static/ffmpeg'
  ].filter(Boolean);
}

export function findFullFfmpeg() {
  const existing = candidateFullFfmpegPaths().find((path) => existsSync(path));
  if (existing) return existing;
  return downloadStaticFfmpeg();
}

function downloadStaticFfmpeg() {
  mkdirSync(TOOLS_DIR, { recursive: true });
  const archive = join(TOOLS_DIR, 'ffmpeg-static.tar.xz');
  const curl = spawnSync(
    'curl',
    ['-sL', '--fail', '-o', archive, STATIC_URL],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  if (curl.status !== 0) {
    throw new Error(`failed to download static ffmpeg from ${STATIC_URL}`);
  }
  const extract = spawnSync('tar', ['xf', archive, '-C', TOOLS_DIR, '--strip-components=1'], {
    stdio: ['ignore', 'inherit', 'inherit']
  });
  if (extract.status !== 0) throw new Error('failed to extract static ffmpeg');
  const binary = join(TOOLS_DIR, 'ffmpeg');
  if (!existsSync(binary)) throw new Error(`static ffmpeg missing after extraction: ${binary}`);
  return binary;
}
