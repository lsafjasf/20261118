/*
 * Player: wires a simulated decoder (producer) to a renderer (consumer)
 * through a bounded FrameQueue.
 *
 * The decoder produces frames at `decodeFps`, the renderer consumes at
 * `renderFps`. With decodeFps = 3 * renderFps roughly 2 of every 3 frames
 * are dropped by the queue's drop-oldest policy, keeping latency bounded
 * and memory flat.
 */
(function (global) {
  'use strict';

  const { FrameQueue, FrameTracker } = global.FrameQueueLib;

  // Simulated decoder: paints a moving pattern onto an OffscreenCanvas and
  // wraps it in a VideoFrame at a fixed rate, like a real decoder callback.
  class SimulatedDecoder {
    constructor({ width, height, fps, onFrame }) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('2d');
      this.intervalMs = 1000 / fps;
      this.onFrame = onFrame;
      this.timer = null;
      this.index = 0;
      this.startTime = 0;
    }

    start() {
      this.startTime = performance.now();
      this.timer = setInterval(() => this.produce(), this.intervalMs);
    }

    produce() {
      const { ctx, canvas } = this;
      const t = this.index;
      ctx.fillStyle = `hsl(${t % 360}, 70%, 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      const x = (t * 7) % canvas.width;
      ctx.fillRect(x, canvas.height / 2 - 20, 40, 40);
      ctx.font = '28px monospace';
      ctx.fillText(String(t), 12, 36);
      const frame = FrameTracker.create(this.canvas, {
        timestamp: Math.round((t * 1e6) / (1000 / this.intervalMs)),
      });
      this.index += 1;
      this.onFrame(frame);
    }

    stop() {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Renderer: pops one frame per tick, draws it, and closes it immediately.
  class Renderer {
    constructor({ canvas, fps, queue }) {
      this.ctx = canvas.getContext('2d');
      this.intervalMs = 1000 / fps;
      this.queue = queue;
      this.timer = null;
      this.rendered = 0;
      this.underruns = 0;
      this.lastRenderAt = 0;
      this.maxGapMs = 0;
    }

    start() {
      this.lastRenderAt = performance.now();
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }

    tick() {
      const frame = this.queue.pop();
      if (!frame) {
        this.underruns += 1;
        return;
      }
      this.ctx.drawImage(frame, 0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
      frame.close();
      const now = performance.now();
      this.maxGapMs = Math.max(this.maxGapMs, now - this.lastRenderAt);
      this.lastRenderAt = now;
      this.rendered += 1;
    }

    stop() {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
    }
  }

  class Player {
    constructor({ canvas, width = 320, height = 180, renderFps = 30, speedup = 3, capacity = 8 }) {
      this.queue = new FrameQueue(capacity);
      this.decoder = new SimulatedDecoder({
        width,
        height,
        fps: renderFps * speedup,
        onFrame: (frame) => this.queue.push(frame),
      });
      this.renderer = new Renderer({ canvas, fps: renderFps, queue: this.queue });
      this.running = false;
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.decoder.start();
      this.renderer.start();
    }

    // Stops both sides and drains the queue so every live VideoFrame is
    // closed and FrameTracker.live returns to zero.
    stop() {
      if (!this.running) return;
      this.decoder.stop();
      this.renderer.stop();
      this.queue.drain();
      this.running = false;
    }

    stats() {
      return {
        queueLength: this.queue.length,
        capacity: this.queue.capacity,
        avgWaitMs: this.queue.avgWaitMs,
        dropped: this.queue.dropped,
        liveFrames: FrameTracker.live,
        created: FrameTracker.created,
        closed: FrameTracker.closed,
        rendered: this.renderer.rendered,
        underruns: this.renderer.underruns,
        maxRenderGapMs: this.renderer.maxGapMs,
      };
    }
  }

  global.Player = Player;
})(typeof self !== 'undefined' ? self : globalThis);
