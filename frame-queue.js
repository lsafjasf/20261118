/*
 * FrameQueue: bounded wait queue for VideoFrame objects.
 *
 * Guarantees:
 *  - The queue never holds more than `capacity` frames.
 *  - Every frame that leaves the queue without being consumed is close()d
 *    exactly once (drop-oldest policy, drain on stop).
 *  - Frames are tracked globally so the number of live VideoFrame objects
 *    is observable and returns to zero after stop().
 */
(function (global) {
  'use strict';

  // Tracks every VideoFrame created through create() until it is closed.
  const FrameTracker = {
    live: 0,
    created: 0,
    closed: 0,
    create(source, init) {
      const frame = new VideoFrame(source, init);
      this.live += 1;
      this.created += 1;
      const origClose = frame.close.bind(frame);
      let done = false;
      frame.close = () => {
        if (done) return;
        done = true;
        origClose();
        this.live -= 1;
        this.closed += 1;
      };
      return frame;
    },
  };

  class FrameQueue {
    constructor(capacity) {
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new Error('capacity must be a positive integer');
      }
      this.capacity = capacity;
      this.items = []; // { frame, enqueuedAt }
      this.dropped = 0;
      this.waitSamples = 0;
      this.waitTotalMs = 0;
    }

    get length() {
      return this.items.length;
    }

    get avgWaitMs() {
      return this.waitSamples === 0 ? 0 : this.waitTotalMs / this.waitSamples;
    }

    // Drop-oldest policy: when full, close the stalest frame and enqueue the
    // fresh one, so playback always shows the newest available picture.
    push(frame, now = performance.now()) {
      if (this.items.length >= this.capacity) {
        const oldest = this.items.shift();
        oldest.frame.close();
        this.dropped += 1;
      }
      this.items.push({ frame, enqueuedAt: now });
    }

    pop(now = performance.now()) {
      const item = this.items.shift();
      if (!item) return null;
      this.waitSamples += 1;
      this.waitTotalMs += now - item.enqueuedAt;
      return item.frame;
    }

    // Close every queued frame; used on stop() so nothing leaks.
    drain() {
      while (this.items.length > 0) {
        this.items.shift().frame.close();
      }
    }
  }

  const api = { FrameQueue, FrameTracker };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.FrameQueueLib = api;
})(typeof self !== 'undefined' ? self : globalThis);
