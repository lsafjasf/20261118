/** Excitation signal generation: exponential (log) sine sweep. */

export interface SweepParams {
  sampleRate: number;
  durationSec: number;
  fStart: number;
  fEnd: number;
  amplitude: number;
  fadeSec: number;
  /** linear: flat energy per Hz (default); log: 1/f energy, classic Farina. */
  type?: "linear" | "log";
}

/**
 * Swept-sine excitation.
 * linear: constant energy per Hz — uniform regularization bias.
 * log (Farina): energy per Hz falls as 1/f; the weak top octave is exactly
 * the kind of band the reliability mask must catch, not "fix" with gain.
 */
export function generateSweep(p: SweepParams): Float32Array {
  const n = Math.round(p.durationSec * p.sampleRate);
  const out = new Float32Array(n);
  if (p.type === "log") {
    const k = (p.fEnd / p.fStart) ** (1 / p.durationSec);
    const w1 = (2 * Math.PI * p.fStart) / Math.log(k);
    for (let t = 0; t < n; t++) {
      const sec = t / p.sampleRate;
      out[t] = p.amplitude * Math.sin(w1 * (Math.pow(k, sec) - 1));
    }
  } else {
    const rate = (p.fEnd - p.fStart) / p.durationSec;
    for (let t = 0; t < n; t++) {
      const sec = t / p.sampleRate;
      const phase = 2 * Math.PI * (p.fStart * sec + 0.5 * rate * sec * sec);
      out[t] = p.amplitude * Math.sin(phase);
    }
  }
  // raised-cosine fades to avoid endpoint clicks
  const fadeN = Math.max(1, Math.round(p.fadeSec * p.sampleRate));
  for (let i = 0; i < fadeN && i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeN);
    out[i] *= g;
    out[n - 1 - i] *= g;
  }
  return out;
}

/** Deterministic white noise (mulberry32) so runs are reproducible. */
export function generateNoise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let state = seed >>> 0;
  for (let i = 0; i < n; i++) {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out[i] = r * 2 - 1;
  }
  return out;
}

/** RMS of a signal. */
export function rms(x: ArrayLike<number>): number {
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / Math.max(1, x.length));
}
