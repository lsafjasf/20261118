// Bounded reorder buffer.
//
// Invariants:
//   * at most `limit` frames are ever held at the same time, so retained
//     memory is O(limit), independent of run time;
//   * frames with seq < nextExpectedSeq are duplicates or too late and are
//     never stored;
//   * an insertion beyond capacity evicts the lowest-seq held frame, which is
//     reported as an expired (skipped) frame;
//   * sweepExpired() drops frames whose end-to-end age already exceeds the
//     expiry budget, advancing the playout cursor past them.

export class ReorderBuffer {
  constructor(limit, expiryMs) {
    this.limit = limit
    this.expiryMs = expiryMs
    this.nextExpectedSeq = 0
    this.frames = new Map()
    this.stats = {
      received: 0,
      inOrder: 0,
      outOfOrder: 0,
      duplicateOrLate: 0,
      expired: 0,
      evicted: 0
    }
  }

  get size() {
    return this.frames.size
  }

  setLimit(limit) {
    this.limit = limit
    const overflow = this.frames.size - limit
    for (let i = 0; i < overflow; i += 1) {
      const oldestSeq = this.smallestSeq()
      this.frames.delete(oldestSeq)
      this.stats.evicted += 1
      this.stats.expired += 1
    }
  }

  smallestSeq() {
    let min = null
    for (const seq of this.frames.keys()) {
      if (min === null || seq < min) min = seq
    }
    return min
  }

  // Returns a reason string when the frame is rejected/expired, otherwise null.
  add(frame, nowMs) {
    this.stats.received += 1
    if (frame.seq < this.nextExpectedSeq) {
      this.stats.duplicateOrLate += 1
      this.stats.expired += 1
      return 'late'
    }
    if (this.frames.has(frame.seq)) {
      this.stats.duplicateOrLate += 1
      return 'duplicate'
    }

    if (frame.seq !== this.nextExpectedSeq) this.stats.outOfOrder += 1
    else this.stats.inOrder += 1

    if (nowMs - frame.sendTimestamp > this.expiryMs) {
      this.stats.expired += 1
      // A late arrival may leave a hole; the scheduler gap logic owns the cursor.
      if (frame.seq === this.nextExpectedSeq) this.nextExpectedSeq += 1
      return 'expired-on-arrival'
    }

    while (this.frames.size > this.limit - 1) {
      const oldestSeq = this.smallestSeq()
      this.frames.delete(oldestSeq)
      this.stats.evicted += 1
      this.stats.expired += 1
      if (oldestSeq === this.nextExpectedSeq) this.nextExpectedSeq += 1
    }
    this.frames.set(frame.seq, frame)
    return null
  }

  // Drop held frames that can no longer meet their deadline.
  sweepExpired(nowMs) {
    for (const [seq, frame] of this.frames) {
      if (nowMs - frame.sendTimestamp <= this.expiryMs) continue
      this.frames.delete(seq)
      this.stats.expired += 1
      if (seq === this.nextExpectedSeq) this.nextExpectedSeq += 1
    }
  }

  takeNext() {
    const frame = this.frames.get(this.nextExpectedSeq)
    if (!frame) return null
    this.frames.delete(this.nextExpectedSeq)
    this.nextExpectedSeq += 1
    return frame
  }

  peekSeq() {
    return this.frames.has(this.nextExpectedSeq) ? this.nextExpectedSeq : null
  }

  // Number of frame slots missing before the next held frame becomes playable.
  gapToNext() {
    if (this.frames.size === 0) return null
    const nextHeld = this.smallestSeq()
    return nextHeld - this.nextExpectedSeq
  }
}
