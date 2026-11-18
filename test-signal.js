// test-signal.js — synthetic fan-noise + short-burst test signal.
// Shared by the browser demo (main.js) and the offline Node test.

function biquadBandpass(sr, freq, q) {
  const w0 = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosw = Math.cos(w0);
  const b0 = alpha;
  const b1 = 0;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  return {
    b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
    a1: a1 / a0, a2: a2 / a0,
    x1: 0, x2: 0, y1: 0, y2: 0,
    step(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
        - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x;
      this.y2 = this.y1; this.y1 = y;
      return y;
    },
  };
}

// Deterministic pseudo-random generator (mulberry32) so tests are repeatable.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Continuous fan noise: pink-ish broadband noise plus a low-frequency
// rumble component, mains hum harmonics and slow blade-rate amplitude
// wobble. RMS is normalised to `level`.
export function synthFan(sampleRate, seconds, { level = 0.12, seed = 7 } = {}) {
  const n = Math.floor(seconds * sampleRate);
  const rng = makeRng(seed);
  const out = new Float32Array(n);
  let brown = 0;
  let p0 = 0, p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const white = rng() * 2 - 1;
    brown = brown * 0.995 + white * 0.05;
    p0 = 0.99765 * p0 + white * 0.099046;
    p1 = 0.963 * p1 + white * 0.2965164;
    p2 = 0.57 * p2 + white * 1.0526913;
    const pink = (p0 + p1 + p2 + white * 0.1848) * 0.25;
    const t = i / sampleRate;
    const hum = 0.25 * Math.sin(2 * Math.PI * 120 * t)
      + 0.12 * Math.sin(2 * Math.PI * 240 * t + 1.3)
      + 0.06 * Math.sin(2 * Math.PI * 360 * t + 0.7);
    const wobble = 1 + 0.25 * Math.sin(2 * Math.PI * 9 * t);
    out[i] = (pink + brown * 1.2 + hum * 0.1) * wobble;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) acc += out[i] * out[i];
  const rms = Math.sqrt(acc / n);
  const scale = level / (rms + 1e-12);
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

// Short speech-like burst: band-passed noise with a fast exponential decay.
export function addBurst(target, sampleRate, atSeconds,
  { durationMs = 35, peak = 0.5, seed = 99 } = {}) {
  const rng = makeRng(seed);
  const bp = biquadBandpass(sampleRate, 1800, 0.8);
  const start = Math.floor(atSeconds * sampleRate);
  const len = Math.floor((durationMs / 1000) * sampleRate);
  const tau = len / 4;
  let maxAbs = 1e-9;
  const tmp = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const env = Math.exp(-i / tau);
    tmp[i] = bp.step(rng() * 2 - 1) * env;
    maxAbs = Math.max(maxAbs, Math.abs(tmp[i]));
  }
  const scale = peak / maxAbs;
  for (let i = 0; i < len && start + i < target.length; i++) {
    target[start + i] += tmp[i] * scale;
  }
  return target;
}

// Fan bed with bursts mixed in at the given times (seconds).
export function synthFanWithBursts(sampleRate, seconds, burstTimes, opts = {}) {
  const sig = synthFan(sampleRate, seconds, opts);
  for (const t of burstTimes) {
    addBurst(sig, sampleRate, t, opts.burst || {});
  }
  return sig;
}
