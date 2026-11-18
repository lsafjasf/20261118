import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReorderBuffer } from '../public/reorder-buffer.js'

const frame = (seq, sendTimestamp = 1000) => ({
  seq,
  sendTimestamp,
  payload: new Uint8Array(4)
})

test('buffer never holds more than its hard limit', () => {
  const buffer = new ReorderBuffer(2, 1000)
  assert.equal(buffer.add(frame(0), 1000), null)
  assert.equal(buffer.add(frame(1), 1000), null)
  assert.equal(buffer.add(frame(2), 1000), null)
  assert.equal(buffer.size, 2)
  assert.ok(buffer.size <= buffer.limit)
})

test('out-of-order frames are reordered before playout', () => {
  const buffer = new ReorderBuffer(4, 1000)
  buffer.add(frame(0), 1000)
  buffer.add(frame(2), 1000)
  buffer.add(frame(1), 1000)
  assert.equal(buffer.takeNext().seq, 0)
  assert.equal(buffer.takeNext().seq, 1)
  assert.equal(buffer.takeNext().seq, 2)
  assert.equal(buffer.stats.outOfOrder, 2)
})

test('late frames below the cursor count as expired', () => {
  const buffer = new ReorderBuffer(4, 1000)
  buffer.add(frame(0), 1000)
  buffer.takeNext()
  const reason = buffer.add(frame(0), 1000)
  assert.equal(reason, 'late')
  assert.equal(buffer.stats.expired, 1)
  assert.equal(buffer.size, 0)
})

test('expiry sweep drops aged frames and advances the cursor', () => {
  const buffer = new ReorderBuffer(4, 100)
  buffer.add(frame(0, 1000), 1000)
  buffer.add(frame(1, 1000), 1000)
  buffer.sweepExpired(1200)
  assert.equal(buffer.size, 0)
  assert.equal(buffer.stats.expired, 2)
  assert.equal(buffer.nextExpectedSeq, 2)
})

test('shrinking the limit evicts surplus oldest frames', () => {
  const buffer = new ReorderBuffer(8, 1000)
  for (let seq = 0; seq < 6; seq += 1) buffer.add(frame(seq), 1000)
  buffer.setLimit(3)
  assert.equal(buffer.size, 3)
  assert.equal(buffer.stats.evicted, 3)
})

test('gap distance is measured from the playout cursor', () => {
  const buffer = new ReorderBuffer(8, 1000)
  buffer.add(frame(3), 1000)
  buffer.add(frame(5), 1000)
  assert.equal(buffer.gapToNext(), 3)
})
