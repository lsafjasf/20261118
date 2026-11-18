// End-to-end test: run the same DeEsser engine used by the AudioWorklet on the
// provided recording and compare attenuation on sibilant vs normal consonants.
'use strict';

const fs = require('fs');
const path = require('path');
const { DeEsser } = require('../src/deesser-engine.js');
const { readWav, writeWavPcm16 } = require('./wav-codec');
const { bandLevelDb, magnitudeSpectrumDb } = require('./fft');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'artifacts');

const loadWav = (p) => {
  const buf = fs.readFileSync(p);
  return readWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};

const wav = loadWav(path.join(outDir, 'test-voice.wav'));
const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'test-voice-segments.json'), 'utf8'));
const sr = wav.sampleRate;
const input = wav.channels[0];
const output = new Float64Array(input.length);

const params = {
  crossoverFreq: 5000,
  thresholdDb: -20,
  maxReductionDb: 10,
  releaseMs: 80,
};

const deEsser = new DeEsser(sr, params, 1);
const stride = 16;
deEsser.enableReductionRecording(input.length, stride);

const BLOCK = 128;
for (let off = 0; off < input.length; off += BLOCK) {
  const len = Math.min(BLOCK, input.length - off);
  const inBlock = [input.subarray(off, off + len)];
  const outBlock = [output.subarray(off, off + len)];
  deEsser.process(inBlock, outBlock);
}
const reductionCurve = deEsser.getReductionCurve();

writeWavAndReport();

function writeWavAndReport() {
  fs.writeFileSync(
  path.join(outDir, 'processed-deessed.wav'),
  writeWavPcm16([Float32Array.from(output)], sr),
  );

  const bands = [
  ['low_0-2k', 0, 2000],
  ['presence_2k-5k', 2000, 5000],
  ['sibilance_5k-10k', 5000, 10000],
  ['air_10k-nyq', 10000, sr / 2],
  ];

  const rows = [];
  for (const seg of meta.segments) {
  const row = { label: seg.label, kind: seg.kind };
  for (const [name, lo, hi] of bands) {
    const before = bandLevelDb(input, seg.start, seg.end, sr, lo, hi);
    const after = bandLevelDb(output, seg.start, seg.end, sr, lo, hi);
    row[name] = after - before;
  }
  const curveSeg = reductionCurve.subarray(
    Math.floor(seg.start / stride),
    Math.floor(seg.end / stride),
  );
  let peak = 0;
  let sum = 0;
  for (const v of curveSeg) {
    peak = Math.max(peak, v);
    sum += v;
  }
  row.peakReductionDb = peak;
  row.meanReductionDb = curveSeg.length ? sum / curveSeg.length : 0;
  rows.push(row);
  }

  console.log(`params: ${JSON.stringify(params)}`);
  console.log('\nPer-segment band attenuation (after - before, dB) and gain reduction:');
  console.log(
  ['segment', 'kind', ...bands.map((b) => b[0]), 'peakGR', 'meanGR']
    .map((h) => h.padEnd(18))
    .join(' '),
  );
  for (const r of rows) {
  console.log(
    [
    r.label,
    r.kind,
    ...bands.map((b) => r[b[0]].toFixed(2)),
    r.peakReductionDb.toFixed(2),
    r.meanReductionDb.toFixed(2),
    ].map((h) => h.padEnd(18)).join(' '),
  );
  }

  // Aggregated comparison required by the task.
  const agg = (kind) => {
  const sel = rows.filter((r) => r.kind === kind);
  const avg = (key) => sel.reduce((a, r) => a + r[key], 0) / sel.length;
  return {
    count: sel.length,
    low: avg('low_0-2k'),
    presence: avg('presence_2k-5k'),
    sibilance: avg('sibilance_5k-10k'),
    air: avg('air_10k-nyq'),
    peakGR: avg('peakReductionDb'),
    meanGR: avg('meanReductionDb'),
  };
  };
  const summary = {
  params,
  sibilant: agg('sibilant'),
  consonant: agg('consonant'),
  vowel: agg('vowel'),
  };
  fs.writeFileSync(path.join(outDir, 'segment-results.json'), JSON.stringify({ rows, summary }, null, 2));

  console.log('\nAggregated attenuation by segment type (dB):');
  console.log(JSON.stringify(summary, null, 2));

  // Spectra for the required before/after chart (sibilant-s-1 and consonant-t).
  const spectra = {};
  for (const label of ['sibilant-s-1', 'consonant-t', 'consonant-f', 'vowel-ah-1']) {
  const seg = meta.segments.find((s) => s.label === label);
  spectra[label] = {
    before: magnitudeSpectrumDb(input, seg.start, seg.end, sr),
    after: magnitudeSpectrumDb(output, seg.start, seg.end, sr),
  };
  }
  fs.writeFileSync(
  path.join(outDir, 'spectra.json'),
  JSON.stringify(spectra, (key, value) => (
    value instanceof Float64Array || value instanceof Float32Array ? Array.from(value) : value
  )),
  );
  fs.writeFileSync(
  path.join(outDir, 'reduction-curve.json'),
  JSON.stringify({
    sampleRate: sr,
    stride,
    params,
    segments: meta.segments,
    curve: Array.from(reductionCurve),
  }),
  );

  console.log('\nwrote artifacts/processed-deessed.wav, segment-results.json, spectra.json, reduction-curve.json');
}
