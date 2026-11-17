// Unit test for FrameQueue logic using a mock VideoFrame (no browser needed).
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);

let nextId = 0;
globalThis.VideoFrame = class {
  constructor() {
    this.id = nextId++;
    this.closed = false;
  }
  close() {
    assert.equal(this.closed, false, `frame ${this.id} closed twice`);
    this.closed = true;
  }
};

const { FrameQueue, FrameTracker } = require('../frame-queue.js');

// 1. Bounded: never exceeds capacity, drops oldest under 3x producer pressure.
{
  const q = new FrameQueue(4);
  for (let i = 0; i < 100; i++) q.push(FrameTracker.create(), i);
  assert.ok(q.length <= 4, 'queue exceeds capacity');
  assert.equal(q.dropped, 96);
  assert.equal(FrameTracker.live, 4, 'dropped frames must be closed');
  q.drain();
  assert.equal(FrameTracker.live, 0, 'drain must close everything');
}

// 2. Drop-oldest: surviving frames are the freshest ones.
{
  const q = new FrameQueue(2);
  const frames = Array.from({ length: 5 }, () => FrameTracker.create());
  frames.forEach((f, i) => q.push(f, i));
  assert.deepEqual(q.items.map((it) => it.frame.id), [frames[3].id, frames[4].id]);
  assert.ok(frames[0].closed && frames[1].closed && frames[2].closed);
  q.drain();
}

// 3. Wait-time accounting.
{
  const q = new FrameQueue(8);
  const f1 = FrameTracker.create();
  const f2 = FrameTracker.create();
  q.push(f1, 1000);
  q.push(f2, 1000);
  q.pop(1010); // waited 10ms
  q.pop(1030); // waited 30ms
  assert.equal(q.avgWaitMs, 20);
  f1.close();
  f2.close();
}

// 4. Full producer/consumer cycle: live count returns to zero.
{
  const q = new FrameQueue(8);
  const before = FrameTracker.live;
  for (let tick = 0; tick < 300; tick++) {
    for (let k = 0; k < 3; k++) q.push(FrameTracker.create()); // 3x decode
    const f = q.pop(); // 1x render
    if (f) f.close();
  }
  assert.ok(q.dropped > 0, 'expected drops under 3x pressure');
  q.drain();
  assert.equal(FrameTracker.live, before, 'live frames must return to baseline');
  assert.equal(FrameTracker.created, FrameTracker.closed);
}

console.log('frame-queue unit tests: all passed');
