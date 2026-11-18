// Generate the source clip and the three corruption variants.
// Run: node scripts/make-fixtures.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import {
  simulateKeyframeCorruption,
  simulatePFrameCorruption,
  simulateMetadataCorruption,
} from '../src/corrupt.js';
import { parseMp4 } from '../src/mp4.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fixtureDir = resolve(root, 'fixtures');
mkdirSync(fixtureDir, { recursive: true });

const sourcePath = resolve(fixtureDir, 'source.mp4');

// Grow the top-level free box so metadata corruption has real, non-sample
// bytes to target. mdat and stco offsets are rewritten to match.
function growFreeBox(bytes, freePayloadSize = 64) {
  const mp4 = parseMp4(bytes);
  const freeBox = mp4.top.find((box) => box.type === 'free');
  if (!freeBox) throw new Error('source has no top-level free box to expand');
  const currentSize = freeBox.size;
  const newSize = 8 + freePayloadSize;
  const delta = newSize - currentSize;
  const out = new Uint8Array(bytes.length + delta);
  out.set(bytes.subarray(0, freeBox.start), 0);
  const view = new DataView(out.buffer);
  view.setUint32(freeBox.start, newSize);
  out.set(new TextEncoder().encode('free'), freeBox.start + 4);
  out.set(bytes.subarray(freeBox.end), freeBox.start + newSize);

  const shifted = parseMp4(out);
  const stco = findStco(shifted);
  const stcoView = new DataView(out.buffer);
  const count = stcoView.getUint32(stco.start + stco.headerSize + 4);
  for (let i = 0; i < count; i += 1) {
    const entryOffset = stco.start + stco.headerSize + 8 + i * 4;
    stcoView.setUint32(entryOffset, stcoView.getUint32(entryOffset) + delta);
  }
  return out;
}

function findStco(mp4) {
  const stbl = mp4.top
    .find((b) => b.type === 'moov').children
    .find((b) => b.type === 'trak').children
    .find((b) => b.type === 'mdia').children
    .find((b) => b.type === 'minf').children
    .find((b) => b.type === 'stbl');
  return stbl.children.find((b) => b.type === 'stco');
}

const filter = 'testsrc2=size=320x240:rate=30:duration=3,hue=H=2*PI*t/3';

execFileSync(ffmpegPath, [
  '-y',
  '-f', 'lavfi', '-i', filter,
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-g', '30',
  '-keyint_min', '30',
  '-sc_threshold', '0',
  '-x264-params', 'force-cfr=1',
  '-movflags', '+faststart',
  '-metadata', 'comment=frame-integrity-fixture',
  sourcePath,
], { stdio: ['ignore', 'ignore', 'inherit'] });

const source = growFreeBox(readFileSync(sourcePath));
writeFileSync(sourcePath, source);
const variants = {
  'corrupt-keyframe.mp4': simulateKeyframeCorruption(source),
  'corrupt-pframe.mp4': simulatePFrameCorruption(source),
  'corrupt-metadata.mp4': simulateMetadataCorruption(source),
};

const manifest = { source: 'source.mp4', variants: {} };
for (const [name, result] of Object.entries(variants)) {
  writeFileSync(resolve(fixtureDir, name), result.buffer);
  manifest.variants[name] = {
    kind: result.kind,
    sampleIndex: result.sampleIndex ?? null,
    containerBox: result.containerBox ?? null,
    byteRuns: result.byteRuns,
  };
}
writeFileSync(resolve(fixtureDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('fixtures written to', fixtureDir);
