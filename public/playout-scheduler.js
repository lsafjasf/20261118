// Deadline-driven playout on top of a ReorderBuffer.
//
// Each frame has a playout deadline of sendTimestamp + playoutDelayMs (plus a
// clock offset learned from control datagrams). A missing frame whose deadline
// passes is counted as a gap (stutter) and the playout cursor moves on, so a
// single loss can never block the stream.

export class PlayoutScheduler {
  constructor(buffer, { playoutDelayMs, frameIntervalMs, now, onFrame }) {
    this.buffer = buffer
    this.basePlayoutDelayMs = playoutDelayMs
    this.playoutDelayMs = playoutDelayMs
    this.frameIntervalMs = frameIntervalMs
    this.now = now
    this.onFrame = onFrame
    this.running = false
    this.timer = null
    this.clockOffsetMs = 0
    this.latencySamples = []
    this.tierSamples = []
    this.stats = {
      played: 0,
      gapSkips: 0,
      deadlineDrops: 0
    }
  }

  setClockOffset(offsetMs) {
    this.clockOffsetMs = offsetMs
  }

  // The playout deadline grows with the buffer tier: a small buffer commits
  // frames quickly (low latency, tolerates stutter), a large buffer waits for
  // reordered frames to arrive (higher latency, fewer gaps).
  setTierDelay(playoutDelayMs) {
    this.playoutDelayMs = playoutDelayMs
    this.tierSamples = []
  }

  serverNowMs() {
    return this.now() + this.clockOffsetMs
  }

  deadlineOf(frame) {
    return frame.sendTimestamp + this.playoutDelayMs
  }

  start() {
    if (this.running) return
    this.running = true
    this.loop()
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  loop() {
    if (!this.running) return
    this.buffer.sweepExpired(this.serverNowMs())

    let waitMs = this.frameIntervalMs
    const frame = this.buffer.takeNext()
    if (frame) {
      const deadline = this.deadlineOf(frame)
      const remaining = deadline - this.serverNowMs()
      if (remaining > 0) {
        waitMs = remaining
      } else {
        this.stats.deadlineDrops += 1
        this.scheduleNext(0)
        return
      }
      this.schedulePlay(frame, Math.max(0, waitMs))
      return
    }

    // Gap handling: if the oldest held frame's slot deadline already passed,
    // jump the cursor and re-evaluate immediately.
    const gap = this.buffer.gapToNext()
    if (gap !== null && gap > 0) {
      const oldest = this.buffer.frames.get(this.buffer.smallestSeq())
      const skipDeadline =
        oldest.sendTimestamp -
        gap * this.frameIntervalMs +
        this.playoutDelayMs
      if (this.serverNowMs() >= skipDeadline) {
        this.buffer.nextExpectedSeq += 1
        this.stats.gapSkips += 1
        this.scheduleNext(0)
        return
      }
      waitMs = Math.min(waitMs, Math.max(1, skipDeadline - this.serverNowMs()))
    }
    this.scheduleNext(waitMs)
  }

  schedulePlay(frame, delayMs) {
    this.timer = setTimeout(() => {
      if (!this.running) return
      const e2e = this.serverNowMs() - frame.sendTimestamp
      this.latencySamples.push(e2e)
      if (this.latencySamples.length > 256) this.latencySamples.shift()
      this.tierSamples.push(e2e)
      this.stats.played += 1
      this.onFrame(frame, e2e)
      this.loop()
    }, delayMs)
  }

  scheduleNext(delayMs) {
    this.timer = setTimeout(() => this.loop(), Math.max(0, delayMs))
  }

  percentile(p) {
    if (this.latencySamples.length === 0) return 0
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    const index = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * p)
    )
    return sorted[index]
  }

  meanLatency() {
    if (this.latencySamples.length === 0) return 0
    return (
      this.latencySamples.reduce((sum, value) => sum + value, 0) /
      this.latencySamples.length
    )
  }

  tierMeanLatency() {
    if (this.tierSamples.length === 0) return 0
    return (
      this.tierSamples.reduce((sum, value) => sum + value, 0) /
      this.tierSamples.length
    )
  }

  tierPercentile(p) {
    if (this.tierSamples.length === 0) return 0
    const sorted = [...this.tierSamples].sort((a, b) => a - b)
    const index = Math.min(
      sorted.length - 1,
      Math.floor(sorted.length * p)
    )
    return sorted[index]
  }
}
