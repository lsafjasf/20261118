// test/offline-test.mjs — offline verification of the SpectralGate DSP core
// against a synthetic fan + short-burst signal. Writes
// artifacts/test-results.json and exits non-zero on failure.
import { writeFile, mkdir } from 'node:fs/promises';
import { SpectralGate } from '../dsp.js';
import { synthFanWithBursts } from '../test-signal.js';

const SR = 48000;
const FFT_SIZE = 1024;
const HOP = 256;
const LAT = FFT_SIZE;

function rms(arr, s, e) {
  let p = 0;
  for (let i = s; i < e; i++) p += arr[i] * arr[i];
  return Math.sqrt(p / (e - s));
}

function runGate(input, chunk) {
  const gate = new SpectralGate({ sampleRate: SR, fftSize: FFT_SIZE, hopSize: HOP });
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += chunk) {
    const end = Math.min(i + chunk, input.length);
    gate.process(input.subarray(i, end), out.subarray(i, end));
  }
  return { out, gate };
}

const db = (v) => 20 * Math.log10(v);
const failures = [];
function check(name, value, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (!pass) failures.push(name);
}

// --- 1. Fan suppression & burst preservation (8 s, bursts at 2/4/6 s) ------
const sig = synthFanWithBursts(SR, 8, [2.0, 4.0, 6.0]);
const { out } = runGate(sig, 128);

const fanS = Math.floor(4.6 * SR);
const fanE = Math.floor(5.8 * SR);
const fanSuppressionDb = db(rms(sig, fanS, fanE) / rms(out, fanS + LAT, fanE + LAT));

const b0 = Math.floor(2.0 * SR);
const b1 = b0 + Math.floor(0.035 * SR);
const o1 = b0 + Math.floor(0.005 * SR);
const pIn = rms(sig, b0, b1);
const pOut = rms(out, b0 + LAT, b1 + LAT);
const pulsePreservationDb = db(pOut / pIn);
const onsetDeltaDb = db((rms(out, b0 + LAT, o1 + LAT) / pOut) / (rms(sig, b0, o1) / pIn));

check('fan-suppression', fanSuppressionDb, fanSuppressionDb > 10,
  `${fanSuppressionDb.toFixed(2)} dB (expect > 10 dB)`);
check('pulse-preservation', pulsePreservationDb, pulsePreservationDb > -3,
  `${pulsePreservationDb.toFixed(2)} dB (expect > -3 dB)`);
check('onset-preservation', onsetDeltaDb, onsetDeltaDb > -3,
  `${onsetDeltaDb.toFixed(2)} dB (expect > -3 dB)`);

// --- 2. Long run: 180 s continuous, drift & chunk-size invariance ----------
const LONG_S = 180;
console.log(`running ${LONG_S}s long-run stability check...`);
const longSig = synthFanWithBursts(SR, LONG_S,
  Array.from({ length: 89 }, (_, i) => 2 + i * 2));
const t0 = Date.now();
const run128 = runGate(longSig, 128);
const run4096 = runGate(longSig, 4096);
let maxError = 0;
for (let i = 0; i < longSig.length; i++) {
  const d = Math.abs(run128.out[i] - run4096.out[i]);
  if (d > maxError) maxError = d;
}
const driftSamples = Math.abs(run128.out.length - longSig.length);
const latencyConstant = run128.gate.latencySamples === FFT_SIZE
  && run128.gate.fifoLen > 0 && run128.gate.fifoLen <= FFT_SIZE + HOP;
// Late-run suppression must still hold (no adaptive-state blowup).
const lateS = Math.floor(170.5 * SR);
const lateE = Math.floor(171.5 * SR);
const lateSupprDb = db(rms(longSig, lateS, lateE)
  / rms(run128.out, lateS + LAT, lateE + LAT));
console.log(`long-run processed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

check('long-run-drift', driftSamples, driftSamples === 0,
  `${driftSamples} samples over ${LONG_S}s (expect 0)`);
check('long-run-chunk-invariance', maxError, maxError < 1e-6,
  `max error ${maxError.toExponential(2)} (expect < 1e-6)`);
check('long-run-latency-constant', latencyConstant, latencyConstant,
  `latency ${run128.gate.latencySamples} samples, fifo ${run128.gate.fifoLen}`);
check('long-run-late-suppression', lateSupprDb, lateSupprDb > 10,
  `${lateSupprDb.toFixed(2)} dB at t=170s (expect > 10 dB)`);

// --- 3. Report --------------------------------------------------------------
const results = {
  generatedAt: new Date().toISOString(),
  sampleRate: SR,
  fftSize: FFT_SIZE,
  hopSize: HOP,
  latencyMs: (LAT / SR) * 1000,
  pulsePreservationDb: Number(pulsePreservationDb.toFixed(2)),
  fanSuppressionDb: Number(fanSuppressionDb.toFixed(2)),
  onsetDeltaDb: Number(onsetDeltaDb.toFixed(2)),
  longRunSeconds: LONG_S,
  longRunMaxError: maxError,
  driftSamples,
};
await mkdir(new URL('../artifacts', import.meta.url), { recursive: true });
await writeFile(new URL('../artifacts/test-results.json', import.meta.url),
  `${JSON.stringify(results, null, 2)}\n`);
console.log('wrote artifacts/test-results.json');

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('all offline checks passed');
