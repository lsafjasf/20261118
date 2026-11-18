/*
 * Cross-check the browser/Node DSP (audio_metrics.js) against the Python
 * reference pipeline (artifacts/metrics.json) on the same WAV. Exits non-zero
 * if loudness/peak/silence differ beyond tolerance. Run with: node crosscheck.js
 */
const fs = require('fs');
const path = require('path');
const { analyze } = require('./audio_metrics.js');

const root = path.join(__dirname, '..', '..');

function readPcm16Mono(file) {
  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== 0x52494646) throw new Error('not RIFF');
  let offset = 12, dataOffset = -1, dataLength = 0, sampleRate = 0, channels = 0, bits = 0;
  while (offset + 8 <= buf.byteLength) {
    const id = dv.getUint32(offset, false);
    const size = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      dataOffset = body; dataLength = size;
    }
    offset = body + size + (size & 1);
  }
  if (bits !== 16) throw new Error('only PCM16 supported, got ' + bits);
  const frames = Math.floor(dataLength / (2 * channels));
  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += dv.getInt16(dataOffset + (i * channels + c) * 2, true) / 32768;
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

const wav = readPcm16Mono(path.join(root, 'artifacts', 'test_track.wav'));
const js = analyze(wav.samples, wav.sampleRate);
const py = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'metrics.json'), 'utf8'));

let failures = 0;
function maxAbs(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}
function check(name, actual, tol) {
  const ok = actual <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: max abs diff = ${actual.toExponential(3)} (tol ${tol})`);
  if (!ok) failures++;
}

const t = py.timeline;
console.log(`frames: python=${t.t_s.length} node=${js.timeline.tS.length}`);
check('frame time (s)', maxAbs(js.timeline.tS, t.t_s), 1e-9);
check('loudness (LUFS)', maxAbs(js.timeline.loudness, t.loudness_lufs), 0.05);
check('peak (dBFS)', maxAbs(js.timeline.peakDbfs, t.peak_dbfs), 0.05);
// Python metrics.json rounds peak time to 3 decimals, so allow 0.5 ms quantization.
check('peak time (s)', maxAbs(js.timeline.peakTimeS, t.peak_time_s), 5e-4 + 1e-6);
check('silence flags', maxAbs(js.timeline.silenceRatio, t.silence_ratio), 0);
check('cell rms (dBFS)', maxAbs(js.timeline.cellRmsDbfs, t.cell_rms_dbfs), 0.05);

// Also verify a dragged local window keeps global coordinates.
const startS = 123.4;
const off = Math.round(startS * wav.sampleRate);
const local = analyze(wav.samples.subarray(off), wav.sampleRate, { globalOffsetSamples: off });
const firstGlobalTime = local.timeline.tS[0];
const okOffset = Math.abs(firstGlobalTime - (off / wav.sampleRate)) < 1e-9;
console.log(`${okOffset ? 'PASS' : 'FAIL'}  local window first frame stays on global axis: ${firstGlobalTime.toFixed(3)} s`);
if (!okOffset) failures++;

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll cross-checks passed: browser DSP matches Python reference.');
