/**
 * Regularized frequency-domain deconvolution estimator.
 *
 * The estimator sees ONLY the excitation x and the observation y.
 *   H[k] = conj(X[k]) · Y[k] / (|X[k]|² + λ·Pmax)
 *
 * Bands where excitation energy |X[k]|² falls below a floor relative to
 * Pmax are flagged unreliable. They are NEVER boosted to compensate:
 * the regularizer keeps the inverse bounded, and the UI masks them out.
 */

import { fft, nextPow2, rfft } from "./fft";

export interface EstimateOptions {
  sampleRate: number;
  /** Regularization strength λ, relative to max|X|². */
  lambda: number;
  /** Excitation-energy floor (dB below max) under which a bin is unreliable. */
  reliabilityFloorDb: number;
  /** Length (samples) of the truncated impulse response estimate. */
  irLength: number;
}

export interface EstimateResult {
  fftSize: number;
  /** Bulk delay (samples) applied before windowing, so the window captures
   *  the non-causal ringing of the band-limited impulse response. */
  bulkDelay: number;
  /** Bin centre frequencies, 0..Nyquist. */
  freqs: Float64Array;
  /** Complex estimated transfer function (positive-frequency bins). */
  hRe: Float64Array;
  hIm: Float64Array;
  /** Excitation power per bin |X[k]|² (positive-frequency bins). */
  excitationPower: Float64Array;
  /** Per-bin reliability flag. */
  reliable: boolean[];
  /** Truncated, windowed impulse-response estimate. */
  impulse: Float64Array;
  /** Time-domain reconstruction residual y − x∗hEst (observation length). */
  residual: Float64Array;
  residualRms: number;
  observationRms: number;
  /** 20·log10(residualRms / observationRms). */
  residualDb: number;
}

export function estimate(
  excitation: ArrayLike<number>,
  observation: ArrayLike<number>,
  opts: EstimateOptions,
): EstimateResult {
  // FFT size covers linear convolution length so circular deconvolution is exact.
  const n = nextPow2(excitation.length + opts.irLength + 64);
  const fx = rfft(excitation, n);
  const fy = rfft(observation, n);

  const bins = n / 2 + 1;
  const freqs = new Float64Array(bins);
  const hRe = new Float64Array(bins);
  const hIm = new Float64Array(bins);
  const excitationPower = new Float64Array(bins);

  let pMax = 0;
  for (let k = 0; k < bins; k++) {
    const p = fx.re[k] * fx.re[k] + fx.im[k] * fx.im[k];
    excitationPower[k] = p;
    if (p > pMax) pMax = p;
  }

  const reg = Math.max(opts.lambda, 1e-12) * pMax;
  const floor = pMax * Math.pow(10, opts.reliabilityFloorDb / 10);
  const reliable: boolean[] = new Array(bins);

  for (let k = 0; k < bins; k++) {
    freqs[k] = (k * opts.sampleRate) / n;
    reliable[k] = excitationPower[k] >= floor;
    const denom = excitationPower[k] + reg;
    // H = conj(X)·Y / (|X|² + λ·Pmax) — bounded even in starved bands.
    hRe[k] = (fx.re[k] * fy.re[k] + fx.im[k] * fy.im[k]) / denom;
    hIm[k] = (fx.re[k] * fy.im[k] - fx.im[k] * fy.re[k]) / denom;
  }

  // Full Hermitian spectrum, shifted by a bulk delay so the causal window
  // also keeps the pre-ringing of the band-limited response near t=0.
  const bulkDelay = Math.min(512, opts.irLength >> 2);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k <= n / 2; k++) {
    const theta = (-2 * Math.PI * k * bulkDelay) / n;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rr = hRe[k] * c - hIm[k] * s;
    const ri = hRe[k] * s + hIm[k] * c;
    re[k] = rr;
    im[k] = ri;
    if (k > 0 && k < n / 2) {
      re[n - k] = rr;
      im[n - k] = -ri;
    }
  }
  fft(re, im, true);

  // Truncate to requested length with a short raised-cosine tail fade.
  const irLength = Math.min(opts.irLength, n);
  const impulse = new Float64Array(irLength);
  const fade = Math.min(64, irLength >> 3);
  for (let i = 0; i < irLength; i++) {
    let g = 1;
    if (fade > 0 && i >= irLength - fade) {
      const t = (i - (irLength - fade)) / fade;
      g = 0.5 + 0.5 * Math.cos(Math.PI * t);
    }
    impulse[i] = re[i] * g;
  }

  // Reconstruction residual: y − x∗hEst, aligned for the bulk delay.
  const convLen = excitation.length + irLength - 1;
  const cn = nextPow2(convLen);
  const fx2 = rfft(excitation, cn);
  const fh2 = rfft(impulse, cn);
  const yre = new Float64Array(cn);
  const yim = new Float64Array(cn);
  for (let k = 0; k < cn; k++) {
    yre[k] = fx2.re[k] * fh2.re[k] - fx2.im[k] * fh2.im[k];
    yim[k] = fx2.re[k] * fh2.im[k] + fx2.im[k] * fh2.re[k];
  }
  fft(yre, yim, true);

  const obsLen = observation.length;
  const residual = new Float64Array(obsLen);
  let resAcc = 0;
  let obsAcc = 0;
  for (let i = 0; i < obsLen; i++) {
    const j = i + bulkDelay;
    const recon = j < convLen ? yre[j] : 0;
    residual[i] = observation[i] - recon;
    resAcc += residual[i] * residual[i];
    obsAcc += observation[i] * observation[i];
  }
  const residualRms = Math.sqrt(resAcc / Math.max(1, obsLen));
  const observationRms = Math.sqrt(obsAcc / Math.max(1, obsLen));
  const residualDb = 20 * Math.log10(Math.max(residualRms, 1e-12) / Math.max(observationRms, 1e-12));

  return {
    fftSize: n,
    bulkDelay,
    freqs,
    hRe,
    hIm,
    excitationPower,
    reliable,
    impulse,
    residual,
    residualRms,
    observationRms,
    residualDb,
  };
}
