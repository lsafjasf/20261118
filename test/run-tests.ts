/** Headless numerical verification of the DSP + estimator pipeline. */

import { convolve, rfft, irfft } from "../src/dsp/fft";
import { generateSweep, generateNoise, rms } from "../src/dsp/excitation";
import { SYSTEMS } from "../src/dsp/systems";
import { estimate } from "../src/dsp/estimator";
import { validate } from "../src/dsp/metrics";

const SR = 48000;
let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  const ok = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${ok}] ${name}${detail ? "  " + detail : ""}`);
}

// --- FFT round-trip ---
{
  const n = 1024;
  const x = Array.from({ length: n }, (_, i) => Math.sin(i * 0.1) + 0.3 * Math.cos(i * 0.03));
  const { re, im } = rfft(x, n);
  const back = irfft(re, im);
  let maxErr = 0;
  for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(back[i] - x[i]));
  check("FFT round-trip", maxErr < 1e-10, `maxErr=${maxErr.toExponential(2)}`);
}

// --- convolution vs direct ---
{
  const a = [1, 2, 3, 4];
  const b = [0.5, -1, 0.25];
  const c = convolve(a, b);
  const expect = [0.5, 0, -0.25, -0.5, -3.25, 1];
  let maxErr = 0;
  for (let i = 0; i < expect.length; i++) maxErr = Math.max(maxErr, Math.abs(c[i] - expect[i]));
  check("convolve matches direct", maxErr < 1e-12, `maxErr=${maxErr.toExponential(2)}`);
}

// --- full pipeline per system, noiseless and noisy ---
for (const snrDb of [Infinity, 30]) {
  for (const sys of SYSTEMS) {
    const x = generateSweep({
      sampleRate: SR,
      durationSec: 2,
      fStart: 50,
      fEnd: 18000,
      amplitude: 0.9,
      fadeSec: 0.01,
      type: "linear",
    });
    const h = sys.build(SR);
    const y = Float32Array.from(convolve(x, h));
    if (snrDb !== Infinity) {
      const noise = generateNoise(y.length, 42);
      const g = rms(y) * Math.pow(10, -snrDb / 20) / rms(noise);
      for (let i = 0; i < y.length; i++) y[i] += noise[i] * g;
    }
    const est = estimate(x, y, {
      sampleRate: SR,
      lambda: 1e-4,
      reliabilityFloorDb: -40,
      irLength: 4096,
    });
    const val = validate(est, h, SR);
    const snrTag = snrDb === Infinity ? "noiseless" : `SNR=${snrDb}dB`;
    console.log(
      `  ${sys.id} [${snrTag}] NMSE=${val.impulseNmseDb.toFixed(1)}dB ` +
        `magErr=${val.reliableMagErrDb.toFixed(3)}dB residual=${est.residualDb.toFixed(1)}dB ` +
        `reliable=${(val.reliableFraction * 100).toFixed(1)}%`,
    );
    if (snrDb === Infinity) {
      // NMSE floor is set by the FIR truncation window, not the estimator.
      check(`${sys.id} noiseless NMSE < -30dB`, val.impulseNmseDb < -30);
      check(`${sys.id} noiseless residual < -40dB`, est.residualDb < -40);
    } else {
      check(`${sys.id} noisy NMSE < -20dB`, val.impulseNmseDb < -20);
    }
    // reliability mask: some bins above the sweep end must be unreliable
    const above = est.freqs.findIndex((f) => f > 19000);
    check(
      `${sys.id} bands beyond sweep end flagged unreliable`,
      above > 0 && !est.reliable[above],
    );
    // no infinite amplification: |H_est| bounded in unreliable region
    let maxUnrel = 0;
    for (let k = 0; k < est.freqs.length; k++) {
      if (!est.reliable[k]) maxUnrel = Math.max(maxUnrel, Math.hypot(est.hRe[k], est.hIm[k]));
    }
    check(`${sys.id} unreliable-band gain bounded`, maxUnrel < 100, `max|H|=${maxUnrel.toFixed(2)}`);
  }
}

// --- regularization effect: larger lambda -> smoother but biased ---
{
  const sys = SYSTEMS[2]; // notch
  const x = generateSweep({
    sampleRate: SR,
    durationSec: 2,
    fStart: 50,
    fEnd: 18000,
    amplitude: 0.9,
    fadeSec: 0.01,
    type: "linear",
  });
  const h = sys.build(SR);
  const y = Float32Array.from(convolve(x, h));
  const noise = generateNoise(y.length, 7);
  const g = rms(y) * Math.pow(10, -20 / 20) / rms(noise);
  for (let i = 0; i < y.length; i++) y[i] += noise[i] * g;
  const nmse = (lam: number) =>
    validate(
      estimate(x, y, { sampleRate: SR, lambda: lam, reliabilityFloorDb: -40, irLength: 4096 }),
      h,
      SR,
    ).impulseNmseDb;
  const small = nmse(1e-8);
  const mid = nmse(1e-4);
  console.log(`  notch SNR=20dB: NMSE λ=1e-8 -> ${small.toFixed(1)}dB, λ=1e-4 -> ${mid.toFixed(1)}dB`);
  check("regularization improves noisy estimate", mid < small);
}

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
