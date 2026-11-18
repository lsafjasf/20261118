import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMp4, sampleAtOffset, classifyOffset } from '../src/mp4.js';
import { parseAvcC, avccToAnnexB, buildAnnexBKeyframe } from '../src/nal.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../fixtures/source.mp4'));

test('parses the full sample table with contiguous, in-file byte ranges', () => {
  const mp4 = parseMp4(source);
  assert.equal(mp4.sampleCount, 90);
  assert.deepEqual(mp4.samples.filter((s) => s.isKey).map((s) => s.index), [0, 30, 60]);
  for (const sample of mp4.samples) {
    assert.ok(sample.size > 0);
    assert.ok(sample.byteRange[1] <= source.length);
  }
  // Adjacent samples inside a chunk are contiguous.
  for (let i = 1; i < mp4.samples.length; i += 1) {
    const prev = mp4.samples[i - 1];
    const current = mp4.samples[i];
    if (current.offset === prev.offset + prev.size) {
      assert.equal(current.offset, prev.byteRange[1]);
    }
  }
});

test('parses avcC with SPS/PPS and 4-byte NAL length size', () => {
  const mp4 = parseMp4(source);
  assert.ok(mp4.avcC);
  const config = parseAvcC(mp4.u8, mp4.avcC.offset, mp4.avcC.length);
  assert.equal(config.nalLengthSize, 4);
  assert.equal(config.sps.length, 1);
  assert.equal(config.pps.length, 1);
  assert.match(config.codec, /^avc1\.[0-9a-f]{6}$/);
  assert.equal(config.sps[0][0] & 0x1f, 7);
  assert.equal(config.pps[0][0] & 0x1f, 8);
});

test('AVCC -> Annex B emits start codes and preserves NAL payload', () => {
  const mp4 = parseMp4(source);
  const config = parseAvcC(mp4.u8, mp4.avcC.offset, mp4.avcC.length);
  const sample = mp4.samples[0];
  const bytes = mp4.u8.subarray(sample.offset, sample.offset + sample.size);
  const annexB = avccToAnnexB(bytes, config.nalLengthSize);
  assert.deepEqual(Array.from(annexB.subarray(0, 4)), [0, 0, 0, 1]);
  const withParams = buildAnnexBKeyframe(config, bytes);
  assert.ok(withParams.length > annexB.length);
  // First NAL units of a keyframe preamble are SPS (7) then PPS (8).
  const firstType = withParams[4] & 0x1f;
  assert.equal(firstType, 7);
});

test('offset classification distinguishes samples from container metadata', () => {
  const mp4 = parseMp4(source);
  const sample = mp4.samples[10];
  assert.deepEqual(classifyOffset(mp4, sample.offset), { kind: 'sample', sampleIndex: 10 });
  const freeBox = mp4.top.find((box) => box.type === 'free');
  const freeHit = classifyOffset(mp4, freeBox.start + 10);
  assert.equal(freeHit.kind, 'container');
  const mvhdHit = classifyOffset(mp4, mp4.top.find((b) => b.type === 'moov').start + 8);
  assert.equal(mvhdHit.kind, 'metadata');
  assert.equal(sampleAtOffset(mp4, freeBox.start + 10), null);
});
