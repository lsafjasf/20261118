import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INPUT_RATE,
  OUTPUT_RATE,
  REFERENCE_TAPS,
} from '../src/config.js';
import { generateInputSignal } from '../src/signal.js';
import { encodeFloat32Wav } from '../src/wav.js';

const REFERENCE_BETA = 11;
const L = 160;
const M = 147;
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outputDirectory = join(root, 'assets');
const outputPath = join(outputDirectory, 'reference-48k.f32.wav');

function modifiedBesselI0(value) {
  let sum = 1;
  let term = 1;
  const quarter = value * value / 4;
  for (let k = 1; k < 40; k += 1) {
    term *= quarter / (k * k);
    sum += term;
    if (term < sum * 1e-16) {
      break;
    }
  }
  return sum;
}

function referenceSinc(distance) {
  if (distance === 0) {
    return 1;
  }
  const x = Math.PI * distance;
  return Math.sin(x) / x;
}

function referenceKernel(phase) {
  const taps = REFERENCE_TAPS;
  const radius = taps / 2;
  const fraction = phase / L;
  const offsets = new Int32Array(taps);
  const weights = new Float64Array(taps);
  const start = Math.ceil(fraction - radius);
  const normalization = modifiedBesselI0(REFERENCE_BETA);
  let sum = 0;

  for (let index = 0; index < taps; index += 1) {
    const offset = start + index;
    const distance = fraction - offset;
    const ratio = distance / radius;
    const window = Math.abs(ratio) <= 1
      ? modifiedBesselI0(REFERENCE_BETA * Math.sqrt(1 - ratio * ratio)) / normalization
      : 0;
    offsets[index] = offset;
    weights[index] = referenceSinc(distance) * window;
    sum += weights[index];
  }

  for (let index = 0; index < taps; index += 1) {
    weights[index] /= sum;
  }

  return { offsets, weights };
}

function renderReference(input) {
  const frames = Math.round(input.frames * L / M);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const phases = Array.from({ length: L }, (_, phase) => referenceKernel(phase));

  for (let frame = 0; frame < frames; frame += 1) {
    const phase = (frame * M) % L;
    const base = Math.floor(frame * M / L);
    const { offsets, weights } = phases[phase];
    let leftSum = 0;
    let rightSum = 0;

    for (let tap = 0; tap < REFERENCE_TAPS; tap += 1) {
      const index = base + offsets[tap];
      if (index >= 0 && index < input.frames) {
        leftSum += input.left[index] * weights[tap];
        rightSum += input.right[index] * weights[tap];
      }
    }

    left[frame] = leftSum;
    right[frame] = rightSum;
  }

  return { left, right, frames };
}

const input = generateInputSignal();
console.time('reference render');
const reference = renderReference(input);
console.timeEnd('reference render');

if (reference.frames !== 288000) {
  throw new Error(`Reference output count mismatch: ${reference.frames}`);
}

const wav = encodeFloat32Wav(reference.left, reference.right, OUTPUT_RATE);
const digest = createHash('sha256').update(Buffer.from(wav)).digest('hex');
const metadata = {
  file: 'reference-48k.f32.wav',
  sha256: digest,
  sampleRate: OUTPUT_RATE,
  inputRate: INPUT_RATE,
  ratio: `${L}/${M}`,
  frames: reference.frames,
  durationSeconds: reference.frames / OUTPUT_RATE,
  tapsPerPhase: REFERENCE_TAPS,
  kaiserBeta: REFERENCE_BETA,
  alignment: 'centered fractional-delay sinc, group delay compensated',
  format: 'IEEE Float32 stereo WAV',
};

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, Buffer.from(wav));
writeFileSync(
  join(outputDirectory, 'reference-48k.json'),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

console.log(`Wrote ${outputPath}`);
console.log(`SHA-256 ${digest}`);
console.log(`Frames ${reference.frames} · ${(wav.byteLength / 1024 / 1024).toFixed(2)} MiB`);
