// Dynamic sibilance (de-esser) engine.
// Shared, environment-free code: runs inside AudioWorkletGlobalScope and in Node tests.
// Architecture:
//   1. Split each channel into high band (2nd-order RBJ high-pass at crossoverFreq)
//      and a perfectly complementary low band (low = x - high), so low + high === x.
//   2. Detect level of the high band only; sibilant transients cross thresholdDb.
//   3. Compute a short-term gain limited to -maxReductionDb, smoothed with a fast
//      attack and user-controlled release.
//   4. Apply the gain to the high band only: y = low + gain * high.
//   The low band is never touched, so the voice cannot be globally low-passed.
'use strict';

const FIXED_ATTACK_MS = 2;

function msToCoeff(ms, sampleRate) {
  // One-pole coefficient so that a 10%->90% step transition takes `ms`.
  if (ms <= 0) return 1;
  const samples = (Math.max(ms, 0.02) / 1000) * sampleRate;
  return 1 - Math.exp(-2.2 / samples);
}

class BiquadHighPass {
  constructor(sampleRate, freq, q = 0.70710678) {
  this.sampleRate = sampleRate;
  this.z1 = 0;
  this.z2 = 0;
  this.setFreq(freq, q);
  }

  setFreq(freq, q = 0.70710678) {
  const w0 = (2 * Math.PI * Math.min(freq, this.sampleRate * 0.49)) / this.sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const a0 = 1 + alpha;
  this.b0 = (1 + cosw) / 2 / a0;
  this.b1 = -(1 + cosw) / a0;
  this.b2 = (1 + cosw) / 2 / a0;
  this.a1 = (-2 * cosw) / a0;
  this.a2 = (1 - alpha) / a0;
  }

  process(input) {
  // Transposed direct form II.
  const out = this.b0 * input + this.z1;
  this.z1 = this.b1 * input - this.a1 * out + this.z2;
  this.z2 = this.b2 * input - this.a2 * out;
  return out;
  }
}

class DeEsser {
  constructor(sampleRate, params = {}, channels = 1) {
  this.sampleRate = sampleRate;
  this.channels = Math.max(1, channels);
  this.filters = [];
  for (let c = 0; c < this.channels; c++) {
    this.filters.push(new BiquadHighPass(sampleRate, 5000));
  }
  // Shared (linked) detector/gain state.
  this.envPower = 0;
  this.gain = 1;
  this.reductionDb = 0;
  // Optional reduction-curve recording.
  this.recordStride = 0;
  this.recordBuf = null;
  this.recordIdx = 0;
  this.sampleCounter = 0;
  // Optional per-sample probe for tests/visualizers: receives {input, high, gain}.
  this.probe = null;
  this.setParams(Object.assign({
    crossoverFreq: 5000,
    thresholdDb: -20,
    maxReductionDb: 10,
    releaseMs: 80,
  }, params));
  }

  setParams(patch = {}) {
  const p = Object.assign({}, this.params || {}, patch);
  p.crossoverFreq = Math.min(Math.max(p.crossoverFreq, 500), this.sampleRate * 0.45);
  p.thresholdDb = Math.min(Math.max(p.thresholdDb, -80), 0);
  p.maxReductionDb = Math.min(Math.max(p.maxReductionDb, 0), 24);
  p.releaseMs = Math.min(Math.max(p.releaseMs, 10), 2000);
  const freqChanged = !this.params || this.params.crossoverFreq !== p.crossoverFreq;
  this.params = p;
  if (freqChanged) {
    for (const f of this.filters) f.setFreq(p.crossoverFreq);
  }
  this.detectAtk = msToCoeff(1, this.sampleRate);
  this.detectRel = msToCoeff(p.releaseMs, this.sampleRate);
  this.gainAtk = msToCoeff(FIXED_ATTACK_MS, this.sampleRate);
  this.gainRel = msToCoeff(p.releaseMs, this.sampleRate);
  this.thresholdLin = 10 ** (p.thresholdDb / 20);
  this.gateLin = this.thresholdLin * 0.25;
  this.minGain = 10 ** (-p.maxReductionDb / 20);
  }

  enableReductionRecording(maxSamples, stride = 1) {
  this.recordStride = Math.max(1, stride | 0);
  this.recordBuf = new Float32Array(Math.ceil(maxSamples / this.recordStride));
  this.recordIdx = 0;
  this.sampleCounter = 0;
  }

  getReductionCurve() {
  return this.recordBuf ? this.recordBuf.subarray(0, this.recordIdx) : null;
  }

  // inputs/outputs: array of per-channel Float32Array/Float64Array of equal length.
  process(inputs, outputs) {
  const n = inputs[0].length;
  const highs = new Array(this.channels);
  for (let c = 0; c < this.channels; c++) highs[c] = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // 1. High band per channel; linked detection on the largest power.
    let maxPower = 0;
    for (let c = 0; c < this.channels; c++) {
    const h = this.filters[c].process(inputs[c][i]);
    highs[c][i] = h;
    const pwr = h * h;
    if (pwr > maxPower) maxPower = pwr;
    }
    // 2. Attack/release follower on high-band power.
    const dCoeff = maxPower > this.envPower ? this.detectAtk : this.detectRel;
    this.envPower += dCoeff * (maxPower - this.envPower);
    const level = Math.sqrt(this.envPower);

    // 3. Downward limiting above threshold, capped at -maxReductionDb.
    // Noise gate at 12 dB below threshold: filter leakage / hiss cannot trigger.
    let targetGain = 1;
    if (level > this.gateLin) {
    targetGain = Math.max(this.minGain, this.thresholdLin / level);
    }
    const gCoeff = targetGain < this.gain ? this.gainAtk : this.gainRel;
    this.gain += gCoeff * (targetGain - this.gain);
    this.reductionDb = Math.max(0, -20 * Math.log10(this.gain + 1e-12));

    // 4. Low band passes untouched; only the high band is scaled.
    for (let c = 0; c < this.channels; c++) {
    const h = highs[c][i];
    outputs[c][i] = (inputs[c][i] - h) + this.gain * h;
    }
    if (this.probe) this.probe({ input: inputs[0][i], high: highs[0][i], gain: this.gain });

    if (this.recordBuf && this.sampleCounter % this.recordStride === 0 && this.recordIdx < this.recordBuf.length) {
    this.recordBuf[this.recordIdx++] = this.reductionDb;
    }
    this.sampleCounter += 1;
  }
  }
}

if (typeof globalThis !== 'undefined') globalThis.DeEsser = DeEsser;
if (typeof module !== 'undefined' && module.exports) module.exports = { DeEsser, BiquadHighPass };
