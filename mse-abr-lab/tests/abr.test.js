const test = require('node:test');
const assert = require('node:assert/strict');
const { createAbrController } = require('../public/abr.js');

const renditions = [
  { id: 'r0', bitrate: 300_000 },
  { id: 'r1', bitrate: 800_000 },
  { id: 'r2', bitrate: 1_500_000 },
];

function feedThroughput(abr, bytes, seconds) {
  abr.reportFetch(bytes, seconds);
}

test('starts on the lowest tier with explicit startup reason', () => {
  const abr = createAbrController(renditions);
  const decision = abr.decide(0, 0);
  assert.equal(decision.rendition, 'r0');
  assert.equal(decision.reason, 'startup');
});

test('upshifts only with enough throughput, buffer and cooldown, at segment boundary', () => {
  const abr = createAbrController(renditions);
  abr.decide(0, 0);
  feedThroughput(abr, 2_000_000 / 8, 1);
  const blocked = abr.decide(1, 12);
  assert.equal(blocked.reason, 'hold-cooldown');
  assert.equal(blocked.rendition, 'r0');

  feedThroughput(abr, 2_000_000 / 8, 1);
  assert.equal(abr.decide(2, 12).reason, 'hold-cooldown');

  feedThroughput(abr, 2_000_000 / 8, 1);
  const up = abr.decide(3, 12);
  assert.equal(up.reason, 'throughput-upshift');
  assert.equal(up.rendition, 'r1');
  assert.equal(up.segmentIndex, 3);
});

test('holds lower tier through cooldown before considering another upshift', () => {
  const abr = createAbrController(renditions);
  abr.decide(0, 0);
  for (const segmentIndex of [1, 2]) {
    feedThroughput(abr, 2_000_000 / 8, 1);
    abr.decide(segmentIndex, 12);
  }
  feedThroughput(abr, 2_000_000 / 8, 1);
  const up = abr.decide(3, 12);
  assert.equal(up.rendition, 'r1');
  feedThroughput(abr, 5_000_000 / 8, 1);
  const waiting = abr.decide(4, 12);
  assert.equal(waiting.reason, 'hold-cooldown');
  assert.equal(waiting.rendition, 'r1');
});

test('refuses upshift when buffer below threshold even with high throughput', () => {
  const abr = createAbrController(renditions);
  abr.decide(0, 0);
  for (const segmentIndex of [1, 2, 3]) {
    feedThroughput(abr, 5_000_000 / 8, 1);
    abr.decide(segmentIndex, 4);
  }
  const decision = abr.decide(4, 4);
  assert.equal(decision.rendition, 'r0');
  assert.equal(decision.reason, 'hold-buffer-building');
});

test('downshifts immediately when throughput cannot sustain current tier', () => {
  const abr = createAbrController(renditions);
  abr.decide(0, 0);
  for (const segmentIndex of [1, 2]) {
    feedThroughput(abr, 2_000_000 / 8, 1);
    abr.decide(segmentIndex, 12);
  }
  feedThroughput(abr, 2_000_000 / 8, 1);
  abr.decide(3, 12);
  assert.equal(abr.getState().currentIndex, 1);

  feedThroughput(abr, 100_000 / 8, 1);
  abr.decide(4, 8);
  feedThroughput(abr, 100_000 / 8, 1);
  const down = abr.decide(5, 8);
  assert.equal(down.reason, 'throughput-downshift');
  assert.equal(down.rendition, 'r0');
});

test('buffer emergency drops to lowest tier regardless of cooldown', () => {
  const abr = createAbrController(renditions);
  abr.decide(0, 0);
  for (const segmentIndex of [1, 2]) {
    feedThroughput(abr, 3_000_000 / 8, 1);
    abr.decide(segmentIndex, 12);
  }
  feedThroughput(abr, 3_000_000 / 8, 1);
  abr.decide(3, 12);
  assert.equal(abr.getState().currentIndex, 1);
  const emergency = abr.decide(4, 2.5);
  assert.equal(emergency.reason, 'buffer-emergency');
  assert.equal(emergency.rendition, 'r0');
});

test('manual lock pauses automatic decisions and is applied at next segment boundary', () => {
  const abr = createAbrController(renditions);
  abr.decide(0, 0);
  abr.lock(2);
  const switched = abr.decide(1, 12);
  assert.equal(switched.reason, 'manual-lock');
  assert.equal(switched.rendition, 'r2');
  const held = abr.decide(2, 12);
  assert.equal(held.reason, 'hold-manual-lock');
  assert.equal(held.rendition, 'r2');

  abr.unlock();
  feedThroughput(abr, 100_000 / 8, 1);
  const autoAgain = abr.decide(3, 2);
  assert.equal(autoAgain.reason, 'buffer-emergency');
  assert.equal(autoAgain.rendition, 'r0');
});

test('every decision carries a concrete reason, never an opaque status', () => {
  const abr = createAbrController(renditions);
  for (let segmentIndex = 0; segmentIndex < 8; segmentIndex += 1) {
    feedThroughput(abr, 1_000_000 / 8, 1);
    abr.decide(segmentIndex, 9);
  }
  const reasons = new Set(abr.getState().history.map((item) => item.reason));
  assert.ok(reasons.size > 1);
  for (const reason of reasons) {
    assert.match(reason, /^(startup|hold-|throughput-|buffer-|manual)/);
  }
});
