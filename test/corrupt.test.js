import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  simulateKeyframeCorruption,
  simulatePFrameCorruption,
  simulateGentlePFrameCorruption,
  simulateMetadataCorruption,
} from '../src/corrupt.js';
import { parseMp4 } from '../src/mp4.js';
import { diffByteRuns, classifyAllRuns } from '../src/compare.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../fixtures/source.mp4'));

function verifyEqualLength(result) {
  assert.equal(result.buffer.length, source.length);
  const runs = diffByteRuns(source, result.buffer);
  assert.ok(runs.length > 0);
  return runs;
}

test('keyframe corruption stays inside the second IDR sample', () => {
  const result = simulateKeyframeCorruption(source);
  const runs = verifyEqualLength(result);
  assert.equal(result.sampleIndex, 30);
  const mp4 = parseMp4(result.buffer);
  const details = classifyAllRuns(mp4, runs);
  assert.ok(details.every((run) => run.kind === 'sample'));
  assert.ok(details.every((run) => run.sampleIndex === 30 && run.isKey));
});

test('P-frame corruption stays inside an inter sample after the second IDR', () => {
  const result = simulatePFrameCorruption(source);
  const runs = verifyEqualLength(result);
  assert.ok(result.sampleIndex > 30);
  const mp4 = parseMp4(result.buffer);
  const details = classifyAllRuns(mp4, runs);
  assert.ok(details.every((run) => run.kind === 'sample'));
  assert.ok(details.every((run) => run.frameType === 'P'));
});

test('metadata corruption touches only container bytes, never sample ranges', () => {
  const result = simulateMetadataCorruption(source);
  const runs = verifyEqualLength(result);
  assert.equal(result.containerBox, 'free');
  const mp4 = parseMp4(result.buffer);
  const details = classifyAllRuns(mp4, runs);
  assert.ok(details.every((run) => run.kind === 'container' || run.kind === 'metadata'));
  for (const sample of mp4.samples) {
    const overlaps = runs.some(
      (run) => run.start < sample.byteRange[1] && run.end > sample.byteRange[0],
    );
    assert.equal(overlaps, false);
  }
});

test('all three scenarios target distinct byte ranges', () => {
  const key = simulateKeyframeCorruption(source);
  const pframe = simulatePFrameCorruption(source);
  const metadata = simulateMetadataCorruption(source);
  const all = [...key.byteRuns, ...pframe.byteRuns, ...metadata.byteRuns];
  const keys = all.map((run) => `${run.start}:${run.end}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('gentle P-frame corruption is a single low-bit in-sample perturbation', () => {
  const result = simulateGentlePFrameCorruption(source);
  assert.equal(result.buffer.length, source.length);
  assert.equal(result.byteRuns.length, 1);
  const mp4 = parseMp4(result.buffer);
  const details = classifyAllRuns(mp4, diffByteRuns(source, result.buffer));
  assert.deepEqual(details.map((run) => run.kind), ['sample']);
  assert.equal(details[0].frameType, 'P');
  const run = result.flips[0];
  const bitDifference = run.original ^ run.mutated;
  assert.ok(bitDifference === 0x02);
  assert.ok(run.mask === 0x02);
});
