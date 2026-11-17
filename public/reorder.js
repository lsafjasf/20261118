// Bounded reorder buffer with deadlines.
//
// Frames are held until their play-out deadline (pts mapped to client clock +
// buffer budget). Frames that miss the deadline — or arrive after it — are
// counted as expired and dropped instead of being chased. The number of
// buffered frames is hard-capped, so memory stays bounded no matter how bad
// the network gets.
export class ReorderBuffer {
  constructor({ name, bufferMs, frameIntervalMs, onEmit, onExpire }) {
    this.name = name;
    this.bufferMs = bufferMs;
    this.capFrames = Math.max(2, Math.ceil(bufferMs / frameIntervalMs) + 4);
    this.onEmit = onEmit;
    this.onExpire = onExpire;
    this.frames = new Map(); // seq -> frame
    this.nextSeq = 0;
    this.anchor = null; // client Date.now() corresponding to pts=0
    this.bufferedBytes = 0;
    this.stats = {
      received: 0,
      emitted: 0,
      expired: 0,
      maxBufferedFrames: 0,
      maxBufferedBytes: 0,
      maxBurst: 0,
    };
  }

  playAt(frame) {
    return this.anchor + frame.pts + this.bufferMs;
  }

  push(frame, now) {
    if (this.anchor === null) this.anchor = now - frame.pts;
    if (frame.seq < this.nextSeq) {
      this.expire(frame, 'too-late');
      return;
    }
    if (this.playAt(frame) <= now) {
      this.expire(frame, 'past-deadline');
      return;
    }
    this.frames.set(frame.seq, frame);
    this.bufferedBytes += frame.size;
    // Hard cap: drop the oldest frame(s) if the buffer overflows.
    while (this.frames.size > this.capFrames) {
      const oldest = Math.min(...this.frames.keys());
      const victim = this.frames.get(oldest);
      this.frames.delete(oldest);
      this.bufferedBytes -= victim.size;
      this.expire(victim, 'cap-overflow');
      if (oldest === this.nextSeq) this.nextSeq++;
    }
    this.stats.maxBufferedFrames = Math.max(this.stats.maxBufferedFrames, this.frames.size);
    this.stats.maxBufferedBytes = Math.max(this.stats.maxBufferedBytes, this.bufferedBytes);
  }

  expire(frame, reason) {
    this.stats.expired++;
    this.onExpire?.(frame, reason);
  }

  // Called periodically; emits due frames in sequence order.
  tick(now) {
    let burst = 0;
    for (;;) {
      const frame = this.frames.get(this.nextSeq);
      if (frame) {
        if (this.playAt(frame) > now) break;
        this.frames.delete(this.nextSeq);
        this.bufferedBytes -= frame.size;
        this.stats.emitted++;
        burst++;
        this.onEmit(frame);
        this.nextSeq++;
        continue;
      }
      // Missing frame: if any later frame is already due, the missing one is
      // considered lost/expired and we stop waiting for it.
      let laterDue = false;
      for (const [seq, f] of this.frames) {
        if (seq > this.nextSeq && this.playAt(f) <= now) {
          laterDue = true;
          break;
        }
      }
      if (!laterDue) break;
      this.stats.expired++;
      this.onExpire?.({ seq: this.nextSeq }, 'lost');
      this.nextSeq++;
    }
    this.stats.maxBurst = Math.max(this.stats.maxBurst, burst);
  }
}
