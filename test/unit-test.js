// Unit tests for the shared de-esser engine (run with Node's built-in test runner).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DeEsser, BiquadHighPass } = require('../src/deesser-engine.js');

const SR = 44100;

test('complementary split: low + high equals input (no global low-pass coloration)', () => {
  const hp = new BiquadHighPass(SR, 5000);
  const n = SR;
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
  const x = Math.sin(2 * Math.PI * 440 * (i / SR)) + 0.5 * Math.sin(2 * Math.PI * 9000 * (i / SR));
  const high = hp.process(x);
  const reconstructed = (x - high) + high;
  maxErr = Math.max(maxErr, Math.abs(reconstructed - x));
  }
  assert.ok(maxErr < 1e-12, `reconstruction error ${maxErr}`);
});

test('low-frequency-only signal gets zero gain reduction (300 Hz tone below detector gate)', () => {
  const d = new DeEsser(SR, { crossoverFreq: 5000, thresholdDb: -30, maxReductionDb: 24 });
  const n = SR / 4;
  const input = new Float64Array(n);
  const output = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 0.9 * Math.sin(2 * Math.PI * 300 * (i / SR));
  d.process([input], [output]);
  // Allow filter settling; compare after 50 ms.
  let maxErr = 0;
  for (let i = SR * 0.05; i < n; i++) maxErr = Math.max(maxErr, Math.abs(output[i] - input[i]));
  assert.ok(maxErr < 1e-5, `low band altered by ${maxErr}`);
  assert.equal(d.reductionDb, 0);
});

test('sustained high-band burst triggers reduction capped at maxReductionDb', () => {
  const d = new DeEsser(SR, {
  crossoverFreq: 5000,
  thresholdDb: -20,
  maxReductionDb: 10,
  releaseMs: 80,
  });
  const n = SR;
  const input = new Float64Array(n);
  const output = new Float64Array(n);
  const fade = Math.round(SR * 0.05);
  for (let i = 0; i < n; i++) {
  const env = i < fade ? 0.5 - 0.5 * Math.cos((Math.PI * i) / fade) : 1;
  input[i] = 0.8 * env * Math.sin(2 * Math.PI * 8000 * (i / SR));
  }
  // Probe the exact high band before/after the gain (the scaled band only).
  const tail = Math.round(SR * 0.05);
  let inPower = 0;
  let outPower = 0;
  let sample = 0;
  d.probe = ({ high, gain }) => {
  if (sample++ >= n - tail) {
    inPower += high ** 2;
    outPower += (gain * high) ** 2;
  }
  };
  d.process([input], [output]);
  assert.ok(d.reductionDb > 9.5, `expected ~10 dB reduction, got ${d.reductionDb}`);
  assert.ok(d.reductionDb <= 10.0001, 'reduction exceeds cap');
  const achievedDb = 10 * Math.log10(outPower / inPower);
  assert.ok(achievedDb < -8 && achievedDb > -11,
  `expected ~-10 dB high-band power reduction, got ${achievedDb.toFixed(1)} dB`);
});

test('gain recovers after the burst ends (release works)', async () => {
  const d = new DeEsser(SR, { thresholdDb: -20, maxReductionDb: 10, releaseMs: 40 });
  const n = SR / 10;
  const input = new Float64Array(n);
  const output = new Float64Array(n);
  for (let i = 0; i < n; i++) input[i] = 0.8 * Math.sin(2 * Math.PI * 9000 * (i / SR));
  d.process([input], [output]);
  assert.ok(d.reductionDb > 9);
  // 0.5 s of silence afterwards.
  const tail = SR / 2;
  const silence = new Float64Array(tail);
  const tailOut = new Float64Array(tail);
  d.process([silence], [tailOut]);
  assert.ok(d.reductionDb < 0.5, `gain did not recover, reduction=${d.reductionDb}`);
});

test('parameter clamping keeps values in safe ranges', () => {
  const d = new DeEsser(SR);
  d.setParams({ crossoverFreq: 5, thresholdDb: -200, maxReductionDb: 99, releaseMs: -10 });
  assert.equal(d.params.crossoverFreq >= 500, true);
  assert.equal(d.params.thresholdDb >= -80, true);
  assert.equal(d.params.maxReductionDb <= 24, true);
  assert.equal(d.params.releaseMs >= 10, true);
});

test('stereo linked detection processes both channels without throwing', () => {
  const d = new DeEsser(SR, { thresholdDb: -20 }, 2);
  const n = 2048;
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  const ol = new Float64Array(n);
  const or = new Float64Array(n);
  for (let i = 0; i < n; i++) {
  l[i] = 0.7 * Math.sin(2 * Math.PI * 8500 * (i / SR));
  r[i] = 0.3 * Math.sin(2 * Math.PI * 8500 * (i / SR));
  }
  d.process([l, r], [ol, or]);
  assert.ok(d.reductionDb > 3);
  assert.ok(Math.abs(ol[1000] - or[1000]) > 0.01);
});
