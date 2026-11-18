import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xxHash32, hashFrameBlocks, diffBlockGrids, XxHash32 } from '../src/hash.js';

// Official xxHash32 sanity-check vectors (seed 0). Byte i is the low
// byte of i * PRIME32_1, matching the upstream xxHash test suite.
const PRIME32_1 = 0x9e3779b1;
const vectors = [
  [0, 0x02cc5d05],
  [1, 0xcf65b03e],
  [14, 0x92772a5e],
  [100, 0xe6ba0077],
];

test('xxHash32 matches official reference vectors', () => {
  for (const [length, expected] of vectors) {
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.imul(i, PRIME32_1) >>> 0) & 0xff;
    }
    assert.equal(xxHash32(data), expected >>> 0);
  }
});

test('streaming hashing equals one-shot hashing', () => {
  const data = new Uint8Array(100);
  for (let i = 0; i < data.length; i += 1) data[i] = i * 7;
  const streaming = new XxHash32();
  streaming.update(data.subarray(0, 30));
  streaming.update(data.subarray(30, 67));
  streaming.update(data.subarray(67));
  assert.equal(streaming.digest(), xxHash32(data));
});

function makeFrame(width, height, fill) {
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  const y = new Uint8Array(width * height).fill(fill.y);
  const u = new Uint8Array(cw * ch).fill(fill.u);
  const v = new Uint8Array(cw * ch).fill(fill.v);
  return {
    width,
    height,
    planes: [
      { width, height, stride: width, data: y, offset: 0 },
      { width: cw, height: ch, stride: cw, data: u, offset: 0 },
      { width: cw, height: ch, stride: cw, data: v, offset: 0 },
    ],
  };
}

test('identical frames produce no changed blocks', () => {
  const frame = makeFrame(32, 32, { y: 100, u: 110, v: 120 });
  const a = hashFrameBlocks(frame, 16);
  const b = hashFrameBlocks(frame, 16);
  assert.equal(diffBlockGrids(a, b).length, 0);
});

test('a single luma pixel change localizes to exactly one block', () => {
  const frame = makeFrame(32, 32, { y: 100, u: 110, v: 120 });
  const reference = hashFrameBlocks(frame, 16);
  frame.planes[0].data[0] = 200;
  const candidate = hashFrameBlocks(frame, 16);
  const changed = diffBlockGrids(reference, candidate);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].plane, 'Y');
  assert.deepEqual([changed[0].row, changed[0].col], [0, 0]);
});

test('chroma change localizes to U/V blocks with luma-equivalent coordinates', () => {
  const frame = makeFrame(32, 32, { y: 100, u: 110, v: 120 });
  const reference = hashFrameBlocks(frame, 8);
  frame.planes[1].data[0] = 10;
  frame.planes[2].data[0] = 20;
  const candidate = hashFrameBlocks(frame, 8);
  const changed = diffBlockGrids(reference, candidate);
  assert.equal(changed.length, 2);
  assert.deepEqual(changed.map((block) => block.plane).sort(), ['U', 'V']);
});
