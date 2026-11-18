import { ReorderBuffer } from './reorder-buffer.js'
import { PlayoutScheduler } from './playout-scheduler.js'
import { decodeFrame, encodeControl, decodeControl } from './shared/protocol.js'
import { tierLimit } from './shared/config.js'

function wallClockNow() {
  return performance.timeOrigin + performance.now()
}

export class MediaClient {
  constructor({ wtUrl, fingerprint, config, WebTransportImpl, onMetrics, onFrame }) {
    this.wtUrl = wtUrl
    this.fingerprint = fingerprint
    this.config = config
    this.WebTransportImpl = WebTransportImpl
    this.onMetrics = onMetrics ?? (() => {})
    this.onFrame = onFrame ?? (() => {})

    this.tier = 'low'
    this.buffer = new ReorderBuffer(
      tierLimit(config, this.tier),
      config.expiryMs
    )
    this.scheduler = new PlayoutScheduler(this.buffer, {
      playoutDelayMs: config.tierPlayoutDelayMs.low,
      frameIntervalMs: config.frameIntervalMs,
      now: wallClockNow,
      onFrame: (frame, e2eMs) => this.onFrame(frame, e2eMs)
    })
    this.transport = null
    this.closed = false
    this.metricsTimer = null
    this.syncTimer = null
    this.maxBufferInTier = 0
  }

  setTier(tier) {
    this.tier = tier
    this.buffer.setLimit(tierLimit(this.config, tier))
    this.maxBufferInTier = this.buffer.size
    const delay = this.config.tierPlayoutDelayMs[tier]
    this.scheduler.setTierDelay(delay)
  }

  async connect() {
    const hashBytes = Uint8Array.from(
      this.fingerprint.split(':').map((hex) => parseInt(hex, 16))
    )
    this.transport = new this.WebTransportImpl(this.wtUrl, {
      serverCertificateHashes: [
        { algorithm: 'sha-256', value: hashBytes }
      ]
    })
    await this.transport.ready

    this.startClockSync()
    this.scheduler.start()
    this.metricsTimer = setInterval(() => this.emitMetrics(), 500)

    const reader = this.transport.datagrams.readable.getReader()
    const receiveLoop = (async () => {
      while (!this.closed) {
        const { done, value } = await reader.read()
        if (done) break
        if (value[0] === 0x02) {
          this.handleControl(decodeControl(value))
          continue
        }
        const frame = decodeFrame(value)
        if (!frame) continue
        this.buffer.add(frame, wallClockNow())
        this.maxBufferInTier = Math.max(
          this.maxBufferInTier,
          this.buffer.size
        )
      }
    })()
    this.receiveLoop = receiveLoop
  }

  startClockSync() {
    const writer = this.transport.datagrams.writable.getWriter()
    const tick = () => {
      if (this.closed) return
      writer
        .write(encodeControl(wallClockNow(), 0))
        .catch(() => {})
    }
    tick()
    this.syncTimer = setInterval(tick, 1000)
  }

  handleControl(control) {
    if (!control) return
    const receiveAt = wallClockNow()
    const rtt = receiveAt - control.clientTimestamp
    const offset =
      control.serverTimestamp - control.clientTimestamp - rtt / 2
    // Simple exponential smoothing, good enough for a same-host demo.
    this.scheduler.setClockOffset(
      this.scheduler.clockOffsetMs * 0.8 + offset * 0.2
    )
  }

  snapshotMetrics() {
    const b = this.buffer.stats
    const s = this.scheduler.stats
    const total = b.received
    return {
      tier: this.tier,
      bufferLimit: this.buffer.limit,
      bufferSize: this.buffer.size,
      maxBufferObserved: this.maxBufferInTier,
      e2eMeanMs: this.scheduler.tierMeanLatency(),
      e2eP95Ms: this.scheduler.tierPercentile(0.95),
      outOfOrderRate: total ? b.outOfOrder / total : 0,
      expiredFrames: b.expired,
      evictedFrames: b.evicted,
      gapSkips: s.gapSkips,
      deadlineDrops: s.deadlineDrops,
      playedFrames: s.played,
      receivedFrames: total,
      clockOffsetMs: this.scheduler.clockOffsetMs
    }
  }

  emitMetrics() {
    this.onMetrics(this.snapshotMetrics())
  }

  async close() {
    this.closed = true
    clearInterval(this.metricsTimer)
    clearInterval(this.syncTimer)
    this.scheduler.stop()
    try {
      await this.transport?.close()
    } catch {
      // already closed
    }
    if (this.receiveLoop) await this.receiveLoop.catch(() => {})
  }
}
