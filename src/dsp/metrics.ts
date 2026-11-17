/**
 * Validation metrics comparing the estimate against the hidden ground truth.
 * Used ONLY for display/reporting — never fed back into the estimator.
 */

import { fft, rfft } from "./fft";
import type { EstimateResult } from "./estimator";

export interface BandError {
  fLow: number;
  fHigh: number;
  /** RMS complex error |Htrue - Hest| over reliable bins in band. */
  complexErr: number;
  /** Mean magnitude error in dB over reliable bins. */
  magErrDb: number;
  reliableBins: number;
  totalBins: number;
}

export interface ValidationResult {
  /** Complex transfer function of the true system at estimator bins. */
  trueRe: Float64Array;
  trueIm: Float64Array;
  /** Per-bin complex error magnitude (all bins). */
  errMag: Float64Array;
  /** Impulse-response NMSE in dB over the overlapping window. */
  impulseNmseDb: number;
  /** Aggregate metrics restricted to reliable bins. */
  reliableComplexErr: number;
  reliableMagErrDb: number;
  reliableFraction: number;
  bands: BandError[];
}

export function validate(
  est: EstimateResult,
  trueImpulse: ArrayLike<number>,
  sampleRate: number,
): ValidationResult {
  const n = est.fftSize;
  const bins = est.freqs.length;
  const ft = rfft(trueImpulse, n);
  const trueRe = ft.re.subarray(0, bins) as Float64Array;
  const trueIm = ft.im.subarray(0, bins) as Float64Array;

  const errMag = new Float64Array(bins);
  let relCount = 0;
  let relErrAcc = 0;
  let relMagDbAcc = 0;
  for (let k = 0; k < bins; k++) {
    const dr = trueRe[k] - est.hRe[k];
    const di = trueIm[k] - est.hIm[k];
    errMag[k] = Math.hypot(dr, di);
    if (est.reliable[k]) {
      relCount++;
      relErrAcc += errMag[k] * errMag[k];
      const tMag = Math.max(Math.hypot(trueRe[k], trueIm[k]), 1e-9);
      const eMag = Math.max(Math.hypot(est.hRe[k], est.hIm[k]), 1e-9);
      relMagDbAcc += Math.abs(20 * Math.log10(eMag / tMag));
    }
  }
  const reliableComplexErr = relCount > 0 ? Math.sqrt(relErrAcc / relCount) : NaN;
  const reliableMagErrDb = relCount > 0 ? relMagDbAcc / relCount : NaN;

  // Impulse NMSE inside the identifiable band only: the true response is
  // projected onto the reliable bins (so band-limitation ringing of the
  // true spike does not count as estimation error), then compared against
  // the windowed estimate, honouring the estimator's bulk delay.
  const tRe = Float64Array.from(ft.re);
  const tIm = Float64Array.from(ft.im);
  for (let k = 0; k < n; k++) {
    const posBin = k <= n / 2 ? k : n - k;
    if (!est.reliable[posBin]) {
      tRe[k] = 0;
      tIm[k] = 0;
    }
  }
  fft(tRe, tIm, true);
  const len = est.impulse.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < len; i++) {
    const trueIdx = (i - est.bulkDelay + n) % n;
    const d = tRe[trueIdx] - est.impulse[i];
    num += d * d;
    den += tRe[trueIdx] * tRe[trueIdx];
  }
  const impulseNmseDb = 10 * Math.log10(Math.max(num, 1e-24) / Math.max(den, 1e-24));

  // Octave-ish bands for the report.
  const edges = [20, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000, sampleRate / 2];
  const bands: BandError[] = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const fLow = edges[b];
    const fHigh = Math.min(edges[b + 1], sampleRate / 2);
    if (fLow >= fHigh) continue;
    let acc = 0;
    let dbAcc = 0;
    let rc = 0;
    let tc = 0;
    for (let k = 0; k < bins; k++) {
      if (est.freqs[k] < fLow || est.freqs[k] >= fHigh) continue;
      tc++;
      if (!est.reliable[k]) continue;
      rc++;
      acc += errMag[k] * errMag[k];
      const tMag = Math.max(Math.hypot(trueRe[k], trueIm[k]), 1e-9);
      const eMag = Math.max(Math.hypot(est.hRe[k], est.hIm[k]), 1e-9);
      dbAcc += Math.abs(20 * Math.log10(eMag / tMag));
    }
    bands.push({
      fLow,
      fHigh,
      complexErr: rc > 0 ? Math.sqrt(acc / rc) : NaN,
      magErrDb: rc > 0 ? dbAcc / rc : NaN,
      reliableBins: rc,
      totalBins: tc,
    });
  }

  return {
    trueRe,
    trueIm,
    errMag,
    impulseNmseDb,
    reliableComplexErr,
    reliableMagErrDb,
    reliableFraction: relCount / bins,
    bands,
  };
}
