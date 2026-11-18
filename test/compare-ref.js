// Compare our processed output against the provided reference de-essed file,
// and verify low-band preservation numerically.
'use strict';

const fs = require('fs');
const path = require('path');
const { readWav } = require('./wav-codec');
const { bandLevelDb } = require('./fft');

const root = path.join(__dirname, '..');
const load = (p) => {
  const buf = fs.readFileSync(p);
  return readWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const orig = load(path.join(root, 'artifacts/test-voice.wav'));
  const mine = load(path.join(root, 'artifacts/processed-deessed.wav'));
const ref = load(path.join(root, 'artifacts/test-voice-deessed.wav'));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/test-voice-segments.json'), 'utf8'));
const sr = orig.sampleRate;

function signalDiff(a, b) {
  let num = 0;
  let den = 0;
  let peak = 0;
  for (let i = 0; i < a.length; i++) {
  num += (a[i] - b[i]) ** 2;
  den += a[i] ** 2;
  peak = Math.max(peak, Math.abs(a[i] - b[i]));
  }
  return { nmseDb: 10 * Math.log10(num / den), peak };
}

console.log('whole-file difference vs reference de-essed:');
console.log(signalDiff(mine.channels[0], ref.channels[0]));

console.log('\nper-segment band delta (ours / reference), dB:');
for (const seg of meta.segments) {
  if (seg.kind === 'silence') continue;
  const cells = [seg.label.padEnd(14), seg.kind.padEnd(10)];
  for (const [lo, hi, tag] of [[0, 2000, 'low'], [5000, 10000, '5-10k'], [10000, sr / 2, 'air']]) {
  const base = bandLevelDb(orig.channels[0], seg.start, seg.end, sr, lo, hi);
  const ours = bandLevelDb(mine.channels[0], seg.start, seg.end, sr, lo, hi) - base;
  const theirs = bandLevelDb(ref.channels[0], seg.start, seg.end, sr, lo, hi) - base;
  cells.push(`${tag.padEnd(6)} ${ours.toFixed(1).padStart(5)}/${theirs.toFixed(1).padStart(5)}`);
  }
  console.log(cells.join(' '));
}
