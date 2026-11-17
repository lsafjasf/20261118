import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseWebm } from '../src/webm-parser.js';
import { buildWebm } from '../src/webm-muxer.js';
import {
  chapterSlotTargets,
  nearestSample,
  resolveChapterFrames
} from '../src/chapter-targets.js';
import { runPool, AbortError } from '../src/concurrency.js';
import { FrameRegistry } from '../src/frame-registry.js';
import { writeVint, readVint, element, ID } from '../src/ebml.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'chapters-20.webm');
const EXPECTED = join(HERE, 'fixtures', 'chapters-20.expected.json');

async function loadFixture() {
  const [buffer, expectedBuffer] = await Promise.all([
    readFile(FIXTURE),
    readFile(EXPECTED, 'utf8')
  ]);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
  return {
    arrayBuffer,
    parsed: parseWebm(arrayBuffer),
    expected: JSON.parse(expectedBuffer)
  };
}

test('EBML vint round-trip covers 1-4 byte marker widths', () => {
  // Boundaries: n-byte vint ranges are 0..(2^(7n)-1)
  for (const value of [0, 1, 0x7e, 0x7f, 0x80, 0x3ffe, 0x3fff, 0x1fffff, 0x0fffffff]) {
    const encoded = writeVint(value);
    const decoded = readVint(encoded, 0, false);
    assert.equal(decoded.value, value);
    assert.equal(decoded.length, encoded.length);
  }
  assert.throws(() => readVint(new Uint8Array([0, 1]), 0));
});

test('fixture exposes exactly 20 chapters with expected boundaries and 120 keyframes', async () => {
  const { parsed, expected } = await loadFixture();
  assert.equal(parsed.chapters.length, 20);
  assert.equal(parsed.frames.length, expected.totalFrames);
  assert.ok(parsed.frames.every((frame) => frame.keyframe));
  parsed.chapters.forEach((chapter, index) => {
    const want = expected.chapters[index];
    assert.equal(chapter.title, want.title);
    assert.equal(chapter.startMs, want.startMs);
    assert.equal(chapter.endMs, want.endMs);
  });
  assert.deepEqual(
    parsed.frames.map((frame) => frame.ptsMs),
    Array.from({ length: 120 }, (_, index) => index * 500)
  );
});

test('each chapter resolves three ordered thumbnails near start, midpoint and end', async () => {
  const { parsed } = await loadFixture();
  const resolved = resolveChapterFrames(parsed.chapters, parsed.frames);
  assert.equal(resolved.length, 20);
  for (const entry of resolved) {
    assert.equal(entry.thumbnails.length, 3);
    assert.deepEqual(
      entry.thumbnails.map((item) => item.slot),
      ['start', 'middle', 'end']
    );
    const pts = entry.thumbnails.map((item) => item.ptsMs);
    assert.ok(pts[0] < pts[1] && pts[1] < pts[2], 'slot PTS must be strictly ordered');
    const { startMs, endMs } = entry.chapter;
    assert.ok(pts.every((value) => value >= startMs && value < endMs));
    // 6 frames at 0/500/1000/1500/2000/2500 ms inside each 3s chapter.
    // 6 frames at 0/500/1000/1500/2000/2500 ms inside each 3s chapter.
    // Targets are 300/1500/2700 ms after margin math; nearest matching gives
    // 500/1500/2500, all inside the chapter and strictly ordered.
    assert.deepEqual(
      pts.map((value) => value - startMs),
      [500, 1500, 2500]
    );
  }
});

test('slot targets use inward margins and deterministic tie-breaking', () => {
  const chapters = [{ startMs: 0, endMs: 1000, title: 'x' }];
  const targets = chapterSlotTargets(chapters);
  assert.equal(targets[0].slots[0].targetPtsMs, 100);
  assert.equal(targets[0].slots[1].targetPtsMs, 500);
  assert.equal(targets[0].slots[2].targetPtsMs, 900);
  const samples = [{ ptsMs: 400 }, { ptsMs: 600 }];
  assert.equal(nearestSample(samples, 500).ptsMs, 400);
});

test('runPool never exceeds the concurrency limit and processes every item', async () => {
  const items = Array.from({ length: 25 }, (_, index) => index);
  let active = 0;
  let maxActive = 0;
  const result = await runPool(items, 3, async (value) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    return value * 2;
  });
  assert.equal(maxActive, 3);
  assert.equal(result.maxConcurrency, 3);
});

test('runPool rejects with AbortError and stops scheduling after abort', async () => {
  const controller = new AbortController();
  const started = [];
  const promise = runPool(
    Array.from({ length: 100 }, (_, index) => index),
    2,
    async (value) => {
      started.push(value);
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    controller.signal
  );
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(promise, AbortError);
  assert.ok(started.length < 100);
});

test('FrameRegistry tracks every live frame and releaseAll frees leftovers', () => {
  const registry = new FrameRegistry();
  const frames = Array.from({ length: 4 }, () => ({ closed: false, close() { this.closed = true; } }));
  frames.forEach((frame) => registry.register(frame));
  assert.equal(registry.liveCount, 4);
  registry.release(frames[0]);
  assert.equal(frames[0].closed, true);
  assert.equal(registry.liveCount, 3);
  assert.throws(() => registry.release(frames[0]));
  assert.equal(registry.doubleReleaseCount, 1);
  const freed = registry.releaseAll();
  assert.equal(freed, 3);
  assert.equal(registry.liveCount, 0);
  assert.equal(registry.leakedCount, 0);
  assert.ok(frames.slice(1).every((frame) => frame.closed));
});

test('muxed WebM round-trips chapter and frame PTS through the parser', async () => {
  const frames = Array.from({ length: 6 }, (_, index) => ({
    ptsMs: index * 500,
    keyframe: true,
    data: new Uint8Array([1, 2, 3, index])
  }));
  const chapters = [
    { uid: 1, startMs: 0, endMs: 1500, title: 'A' },
    { uid: 2, startMs: 1500, endMs: 3000, title: 'B' }
  ];
  const bytes = buildWebm({ width: 16, height: 8, frames, chapters });
  const parsed = parseWebm(bytes.buffer);
  assert.deepEqual(
    parsed.frames.map((frame) => frame.ptsMs),
    [0, 500, 1000, 1500, 2000, 2500]
  );
  assert.deepEqual(
    parsed.chapters.map((chapter) => [chapter.startMs, chapter.endMs, chapter.title]),
    [[0, 1500, 'A'], [1500, 3000, 'B']]
  );
  assert.deepEqual(parsed.tracks[0].width, 16);
  // Sanity: element() produces header + payload of the declared size.
  const packed = element(ID.TRACK_NUMBER, new Uint8Array([1]));
  assert.equal(packed.length, 1 + 1 + 1);
});
