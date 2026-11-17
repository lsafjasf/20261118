import { encodeDatagram, KIND_AUDIO, KIND_VIDEO, MAX_CHUNK_PAYLOAD } from '../public/protocol.js';
import { makeRng } from './media.js';

// Streams stored media frames over WebTransport datagrams, paced by pts.
// Each frame is split into small chunks; every chunk gets an independent
// artificial delay so frames genuinely arrive out of order on the wire.
export class Streamer {
  constructor(store, config, log = () => {}) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.rng = makeRng(config.seed ?? 42);
    this.timers = [];
    this.sentChunks = 0;
    this.sentFrames = 0;
  }

  impairmentDelay() {
    const { jitterMs = 0, spikeMs = 0, spikeProb = 0 } = this.config;
    let d = this.rng() * jitterMs;
    if (spikeMs > 0 && this.rng() < spikeProb) d += spikeMs;
    return d;
  }

  buildTimeline() {
    const { video, audio } = this.store;
    const frames = [];
    video.chunks.forEach((c, i) =>
      frames.push({ kind: KIND_VIDEO, seq: i, pts: c.ts, dur: c.dur, type: c.type, data: c.data })
    );
    audio.chunks.forEach((c, i) =>
      frames.push({ kind: KIND_AUDIO, seq: i, pts: c.ts, dur: c.dur, type: c.type, data: c.data })
    );
    frames.sort((a, b) => a.pts - b.pts || a.kind - b.kind);
    const durationMs = this.config.durationMs ?? Infinity;
    return frames.filter((f) => f.pts <= durationMs);
  }

  // writer: object with write(Uint8Array); onDone: called after last chunk sent
  start(writer, onDone) {
    const frames = this.buildTimeline();
    const t0 = Date.now();
    let lastDispatch = 0;
    for (const frame of frames) {
      const data = frame.data;
      const chunkCount = Math.max(1, Math.ceil(data.byteLength / MAX_CHUNK_PAYLOAD));
      for (let idx = 0; idx < chunkCount; idx++) {
        const payload = data.subarray(
          idx * MAX_CHUNK_PAYLOAD,
          Math.min(data.byteLength, (idx + 1) * MAX_CHUNK_PAYLOAD)
        );
        const dispatchIn = frame.pts + this.impairmentDelay();
        lastDispatch = Math.max(lastDispatch, dispatchIn);
        const timer = setTimeout(() => {
          const sendTs = Date.now();
          writer.write(
            encodeDatagram(
              frame.kind,
              frame.seq,
              idx,
              chunkCount,
              frame.pts,
              sendTs,
              payload,
              frame.type === 'key' ? 1 : 0
            )
          );
          this.sentChunks++;
        }, dispatchIn);
        this.timers.push(timer);
      }
      this.sentFrames++;
    }
    const doneTimer = setTimeout(() => {
      this.log(`stream done: frames=${this.sentFrames} chunks=${this.sentChunks}`);
      onDone?.();
    }, lastDispatch + 300);
    this.timers.push(doneTimer);
    return { frameCount: frames.length, t0 };
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
