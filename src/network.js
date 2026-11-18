// Artificial network impairment: random one-way delay, reordering and loss.
// Every scheduled send is tracked so it can be cancelled on shutdown, and the
// pending queue has a hard cap so memory cannot grow with uptime.

export class ImpairedSender {
  constructor(writer, options) {
    this.writer = writer
    this.options = options
    this.pending = new Set()
    this.closed = false
    this.stats = {
      produced: 0,
      sent: 0,
      lost: 0,
      queueFull: 0
    }
  }

  get pendingCount() {
    return this.pending.size
  }

  send(bytes) {
    if (this.closed) return
    this.stats.produced += 1
    if (Math.random() < this.options.lossProbability) {
      this.stats.lost += 1
      return
    }
    if (this.pending.size >= this.options.maxPending) {
      this.stats.queueFull += 1
      return
    }

    const base =
      this.options.delayMinMs +
      Math.random() * (this.options.delayMaxMs - this.options.delayMinMs)
    const extra =
      Math.random() < this.options.reorderProbability
        ? this.options.reorderExtraDelayMs
        : 0
    const delay = base + extra

    const timer = setTimeout(() => {
      this.pending.delete(timer)
      if (this.closed) return
      this.stats.sent += 1
      Promise.resolve(this.writer.write(bytes)).catch(() => this.close())
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
    this.pending.add(timer)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const timer of this.pending) clearTimeout(timer)
    this.pending.clear()
    try {
      await this.writer.close()
    } catch {
      // writer may already be gone when the session ended
    }
  }
}
