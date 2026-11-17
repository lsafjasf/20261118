// Tracks every live VideoFrame so that:
//  - tests can assert no frame leaks after completion or cancellation
//  - an abort path can releaseAll() any frame still in flight
//  - double-close mistakes surface immediately instead of silently leaking

export class FrameRegistry {
  #live = new Set();
  #created = 0;
  #released = 0;
  #doubleReleases = 0;

  register(frame) {
    if (!frame || typeof frame.close !== 'function') {
      throw new TypeError('register() expects a VideoFrame-like object with close()');
    }
    this.#created++;
    this.#live.add(frame);
    return frame;
  }

  release(frame) {
    if (frame == null) return;
    if (!this.#live.has(frame)) {
      this.#doubleReleases++;
      throw new Error('release() called for a frame that is not registered or already released');
    }
    this.#live.delete(frame);
    this.#released++;
    frame.close();
  }

  // Used on the cancellation path: decoder.reset() may drop queued outputs,
  // so every frame still registered must be closed explicitly here.
  releaseAll() {
    let count = 0;
    for (const frame of this.#live) {
      frame.close();
      count++;
    }
    this.#live.clear();
    this.#released += count;
    return count;
  }

  get liveCount() {
    return this.#live.size;
  }

  get createdCount() {
    return this.#created;
  }

  get releasedCount() {
    return this.#released;
  }

  get doubleReleaseCount() {
    return this.#doubleReleases;
  }

  get leakedCount() {
    return this.#live.size;
  }

  snapshot() {
    return {
      created: this.#created,
      released: this.#released,
      live: this.#live.size,
      doubleReleases: this.#doubleReleases
    };
  }
}
