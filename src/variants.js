// Query-variant transforms: clip, noise, resample (speed/pitch), OLA stretch.
import { SAMPLE_RATE, makeRng } from "./song.js";

export function clip(pcm, startSec, durSec) {
  const s0 = Math.floor(startSec * SAMPLE_RATE);
  const n = Math.floor(durSec * SAMPLE_RATE);
  return pcm.slice(s0, s0 + n);
}

export function addNoise(pcm, snrDb, seed = 999) {
  const rng = makeRng(seed);
  let sigPow = 0;
  for (let i = 0; i < pcm.length; i++) sigPow += pcm[i] * pcm[i];
  sigPow /= pcm.length;
  const noisePow = sigPow / Math.pow(10, snrDb / 10);
  const amp = Math.sqrt(noisePow);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i] + amp * (rng() * 2 - 1) * 1.7;
  }
  return out;
}

// Resample by `ratio`: output length = len / ratio.
// ratio > 1 => faster playback, shorter, higher pitch (vinyl-style speedup).
export function resampleAt(pcm, ratio) {
  const n = Math.floor(pcm.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = pcm[Math.min(i0, pcm.length - 1)];
    const b = pcm[Math.min(i0 + 1, pcm.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Crude OLA time-stretch: factor > 1 => longer, same pitch.
export function timeStretch(pcm, factor) {
  const grain = 1024, hop = 256;
  const outLen = Math.floor(pcm.length * factor);
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  const win = new Float32Array(grain);
  for (let i = 0; i < grain; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
  }
  const inHop = hop / factor;
  for (let o = 0, pos = 0; o + grain <= outLen && pos + grain <= pcm.length; o += hop, pos += inHop) {
    const p0 = Math.floor(pos);
    for (let i = 0; i < grain; i++) {
      out[o + i] += pcm[p0 + i] * win[i];
      norm[o + i] += win[i];
    }
  }
  for (let i = 0; i < outLen; i++) {
    if (norm[i] > 1e-6) out[i] /= norm[i];
  }
  return out;
}

// Pitch-only shift (tempo preserved): stretch then resample back.
export function pitchShift(pcm, semitones) {
  const r = Math.pow(2, semitones / 12);
  const stretched = timeStretch(pcm, r);
  return resampleAt(stretched, r);
}
