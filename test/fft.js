// Small radix-2 FFT and spectral helpers (real signals only).
'use strict';

function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
  let bit = n >> 1;
  for (; j & bit; bit >>= 1) j ^= bit;
  j ^= bit;
  if (i < j) {
    [re[i], re[j]] = [re[j], re[i]];
    [im[i], im[j]] = [im[j], im[i]];
  }
  }
  for (let len = 2; len <= n; len <<= 1) {
  const ang = (-2 * Math.PI) / len;
  const wRe = Math.cos(ang);
  const wIm = Math.sin(ang);
  const half = len >> 1;
  for (let i = 0; i < n; i += len) {
    let curRe = 1;
    let curIm = 0;
    for (let j = 0; j < half; j++) {
    const uRe = re[i + j];
    const uIm = im[i + j];
    const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
    const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
    re[i + j] = uRe + vRe;
    im[i + j] = uIm + vIm;
    re[i + j + half] = uRe - vRe;
    im[i + j + half] = uIm - vIm;
    const nextRe = curRe * wRe - curIm * wIm;
    curIm = curRe * wIm + curIm * wRe;
    curRe = nextRe;
    }
  }
  }
}

function nextPow2(n) {
  return 2 ** Math.ceil(Math.log2(n));
}

// Average power spectral density (dB) within [loHz, hiHz].
// No zero-padding: the segment is windowed and its own-length DFT is used, so
// bin widths stay matched to the segment and short low-band segments do not
// leak into the estimate. Length is rounded to a power of two by trimming.
function bandLevelDb(x, start, end, sampleRate, loHz, hiHz) {
  let segLen = end - start;
  const n = 2 ** Math.floor(Math.log2(segLen));
  const offset = start + Math.floor((segLen - n) / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowPower = 0;
  for (let i = 0; i < n; i++) {
  const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  re[i] = x[offset + i] * w;
  windowPower += w * w;
  }
  fft(re, im);
  const binHz = sampleRate / n;
  const k1 = Math.max(1, Math.round(loHz / binHz));
  const k2 = Math.min(n / 2, Math.round(hiHz / binHz));
  let sum = 0;
  let count = 0;
  for (let k = k1; k <= k2; k++) {
  sum += re[k] * re[k] + im[k] * im[k];
  count += 1;
  }
  // Hann coherent/power normalization so levels compare across segment lengths.
  return 10 * Math.log10((2 * sum) / (count * windowPower * n) + 1e-12);
}

// Full magnitude spectrum (dB) for plotting. Returns {freqs, db}.
function magnitudeSpectrumDb(x, start, end, sampleRate, points = 256) {
  let segLen = end - start;
  const n = 2 ** Math.floor(Math.log2(segLen));
  const offset = start + Math.floor((segLen - n) / 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let windowPower = 0;
  for (let i = 0; i < n; i++) {
  const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  re[i] = x[offset + i] * w;
  windowPower += w * w;
  }
  fft(re, im);
  const nyq = sampleRate / 2;
  const freqs = new Float64Array(points);
  const db = new Float64Array(points);
  for (let p = 0; p < points; p++) {
  // Log-spaced frequency axis from 60 Hz to Nyquist.
  const f = 60 * (nyq / 60) ** (p / (points - 1));
  freqs[p] = f;
  const k = Math.max(1, Math.min(n / 2 - 1, Math.round((f * n) / sampleRate)));
  const mag = Math.sqrt((2 * (re[k] * re[k] + im[k] * im[k])) / (windowPower * n));
  db[p] = 20 * Math.log10(mag + 1e-9);
  }
  return { freqs, db };
}

module.exports = { fft, bandLevelDb, magnitudeSpectrumDb, nextPow2 };
