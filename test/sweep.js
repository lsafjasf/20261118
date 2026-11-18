// Parameter sweep: verify sibilant vs normal-consonant discrimination and
// the effect of threshold / max reduction / recovery speed.
'use strict';

const fs = require('fs');
const path = require('path');
const { DeEsser } = require('../src/deesser-engine.js');
const { readWav } = require('./wav-codec');
const { bandLevelDb } = require('./fft');

const root = path.join(__dirname, '..');
const buf = fs.readFileSync(path.join(root, 'artifacts/test-voice.wav'));
const wav = readWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/test-voice-segments.json'), 'utf8'));
const sr = wav.sampleRate;
const input = wav.channels[0];

function run(params) {
  const out = new Float64Array(input.length);
  const d = new DeEsser(sr, params, 1);
  const stride = 16;
  d.enableReductionRecording(input.length, stride);
  const BLOCK = 128;
  for (let off = 0; off < input.length; off += BLOCK) {
  const len = Math.min(BLOCK, input.length - off);
  d.process([input.subarray(off, off + len)], [out.subarray(off, off + len)]);
  }
  const curve = d.getReductionCurve();
  const reduction = (kind) => {
  const segs = meta.segments.filter((s) => s.kind === kind);
  let peakSum = 0;
  let meanSum = 0;
  for (const s of segs) {
    const a = Math.floor(s.start / stride);
    const b = Math.floor(s.end / stride);
    let peak = 0;
    let mean = 0;
    for (let i = a; i < b; i++) {
    peak = Math.max(peak, curve[i]);
    mean += curve[i];
    }
    peakSum += peak;
    meanSum += mean / Math.max(1, b - a);
  }
  return { peak: peakSum / segs.length, mean: meanSum / segs.length };
  };
  const agg = (kind, band) => {
  const segs = meta.segments.filter((s) => s.kind === kind);
  let sum = 0;
  for (const s of segs) {
    sum += bandLevelDb(out, s.start, s.end, sr, band[0], band[1])
    - bandLevelDb(input, s.start, s.end, sr, band[0], band[1]);
  }
  return sum / segs.length;
  };
  return {
  sib510: agg('sibilant', [5000, 10000]),
  con510: agg('consonant', [5000, 10000]),
  sibAir: agg('sibilant', [10000, sr / 2]),
  conAir: agg('consonant', [10000, sr / 2]),
  vowLow: agg('vowel', [0, 2000]),
  conLow: agg('consonant', [0, 2000]),
  gr: {
    sibilant: reduction('sibilant'),
    consonant: reduction('consonant'),
  },
  };
}

const base = { crossoverFreq: 5000, thresholdDb: -20, maxReductionDb: 10, releaseMs: 80 };
console.log('threshold sweep (5-10k attenuation dB):');
for (const thresholdDb of [-28, -24, -20, -16, -12]) {
  const r = run(Object.assign({}, base, { thresholdDb }));
  console.log(
  `thr ${String(thresholdDb).padStart(3)} dB  sibGR pk/mean ${r.gr.sibilant.peak.toFixed(1).padStart(5)}/${r.gr.sibilant.mean.toFixed(1).padStart(5)}  conGR pk/mean ${r.gr.consonant.peak.toFixed(1).padStart(5)}/${r.gr.consonant.mean.toFixed(1).padStart(5)}  sibAir ${r.sibAir.toFixed(2).padStart(6)}  vowelLow ${r.vowLow.toFixed(2)}`,
  );
}
console.log('\nmax reduction sweep:');
for (const maxReductionDb of [4, 8, 10, 12, 16]) {
  const r = run(Object.assign({}, base, { maxReductionDb }));
  console.log(
  `max ${String(maxReductionDb).padStart(2)} dB  sibAir ${r.sibAir.toFixed(2).padStart(6)}  conAir ${r.conAir.toFixed(2).padStart(6)}  sib5-10k ${r.sib510.toFixed(2).padStart(6)}`,
  );
}
console.log('\nrelease sweep (recovery speed):');
for (const releaseMs of [30, 60, 100, 250, 500]) {
  const r = run(Object.assign({}, base, { releaseMs }));
  console.log(
  `rel ${String(releaseMs).padStart(3)} ms  sibGR pk/mean ${r.gr.sibilant.peak.toFixed(1).padStart(5)}/${r.gr.sibilant.mean.toFixed(1).padStart(5)}  conGR mean ${r.gr.consonant.mean.toFixed(1).padStart(5)}  sibAir ${r.sibAir.toFixed(2).padStart(6)}  vowelLow ${r.vowLow.toFixed(2)}`,
  );
}
console.log('\ncrossover sweep:');
for (const crossoverFreq of [4000, 5000, 6500, 8000]) {
  const r = run(Object.assign({}, base, { crossoverFreq }));
  console.log(
  `fc ${String(crossoverFreq).padStart(5)} Hz  sib5-10k ${r.sib510.toFixed(2).padStart(6)}  con5-10k ${r.con510.toFixed(2).padStart(6)}  sibAir ${r.sibAir.toFixed(2).padStart(6)}  vowelLow ${r.vowLow.toFixed(2)}`,
  );
}
