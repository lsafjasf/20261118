import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  INPUT_FRAMES,
  OUTPUT_FRAMES,
  OUTPUT_RATE,
  REFERENCE_TAPS,
  TAP_OPTIONS,
  TRANSIENT_TIME,
} from '../src/config.js';
import { compareWithReference } from '../src/analysis.js';
import {
  expectedOutputFrames,
  measureStereoSkew,
  peakAround,
  resampleStereo,
} from '../src/resampler.js';
import { generateInputSignal } from '../src/signal.js';
import { decodeFloat32Wav, encodeFloat32Wav } from '../src/wav.js';

const input = generateInputSignal();
const referenceBytes = readFileSync(new URL('../assets/reference-48k.f32.wav', import.meta.url));
const referenceArrayBuffer = referenceBytes.buffer.slice(
  referenceBytes.byteOffset,
  referenceBytes.byteOffset + referenceBytes.byteLength,
);
const reference = decodeFloat32Wav(referenceArrayBuffer);
const metadata = JSON.parse(
  readFileSync(new URL('../assets/reference-48k.json', import.meta.url), 'utf8'),
);

test('reference file is stereo Float32 at 48 kHz with exact duration', () => {
  assert.equal(reference.sampleRate, OUTPUT_RATE);
  assert.equal(reference.channels, 2);
  assert.equal(reference.bitsPerSample, 32);
  assert.equal(reference.frames, OUTPUT_FRAMES);
  assert.equal(reference.frames / reference.sampleRate, 6);
  assert.equal(metadata.frames, OUTPUT_FRAMES);
  assert.equal(metadata.tapsPerPhase, REFERENCE_TAPS);
  assert.equal(
    createHash('sha256').update(referenceBytes).digest('hex'),
    metadata.sha256,
  );
});

test('160/147 ratio always produces the target frame count', () => {
  assert.equal(expectedOutputFrames(INPUT_FRAMES), OUTPUT_FRAMES);
  assert.equal(INPUT_FRAMES * 160 / 147, OUTPUT_FRAMES);

  for (const taps of TAP_OPTIONS) {
    const result = resampleStereo(input, taps);
    assert.equal(result.outputFrames, OUTPUT_FRAMES);
    assert.equal(result.duration, 6);
    assert.equal(result.left.length, OUTPUT_FRAMES);
    assert.equal(result.right.length, OUTPUT_FRAMES);
  }
});

test('stereo channels share one time base and zero sample skew', () => {
  for (const taps of [32, 128, 256]) {
    const result = resampleStereo(input, taps);
    assert.equal(
      measureStereoSkew(
        result.left,
        result.right,
        TRANSIENT_TIME * OUTPUT_RATE,
        OUTPUT_RATE,
      ),
      0,
    );
    assert.equal(result.stereoSkewSamples, 0);
  }
});

test('output is finite and transient remains on the reference time base', () => {
  const result = resampleStereo(input, 128);
  for (let index = 0; index < result.outputFrames; index += 1) {
    assert.ok(Number.isFinite(result.left[index]));
    assert.ok(Number.isFinite(result.right[index]));
  }
  assert.ok(Math.abs(result.groupDelayMs - 64 / 44100 * 1000) < 1e-10);
  const currentPeak = peakAround(result.left, TRANSIENT_TIME * OUTPUT_RATE, 480);
  const referencePeak = peakAround(reference.left, TRANSIENT_TIME * OUTPUT_RATE, 480);
  assert.ok(Math.abs(currentPeak.index - referencePeak.index) <= 1);
});

test('128-tap output meets head, transient, tail and full-file reference limits', () => {
  const result = resampleStereo(input, 128);
  const comparison = compareWithReference(
    { left: Float32Array.from(result.left), right: Float32Array.from(result.right) },
    reference,
  );
  const region = Object.fromEntries(
    comparison.regions.map((item) => [item.id, item]),
  );

  assert.ok(comparison.overall.peak < 2e-3);
  assert.ok(region.head.peak < 1e-5);
  assert.ok(region.transient.peak < 2e-3);
  assert.ok(region.tail.peak < 1e-6);
  assert.ok(region.transient.peakLeft > region.transient.peakRight);
});

test('longer filters reduce transient error monotonically', () => {
  const errors = [32, 64, 128, 256].map((taps) => {
    const result = resampleStereo(input, taps);
    const comparison = compareWithReference(
      { left: Float32Array.from(result.left), right: Float32Array.from(result.right) },
      reference,
    );
    return comparison.regions.find((item) => item.id === 'transient').peak;
  });

  for (let index = 1; index < errors.length; index += 1) {
    assert.ok(errors[index] < errors[index - 1]);
  }
  assert.ok(errors.at(-1) < 6e-4);
});

test('Float32 WAV export round-trips sample data and frame count', () => {
  const left = Float32Array.from([0.25, -0.5, 0.75]);
  const right = Float32Array.from([-0.25, 0.5, -0.75]);
  const decoded = decodeFloat32Wav(encodeFloat32Wav(left, right, OUTPUT_RATE));
  assert.equal(decoded.frames, 3);
  assert.deepEqual(decoded.left, left);
  assert.deepEqual(decoded.right, right);
});
