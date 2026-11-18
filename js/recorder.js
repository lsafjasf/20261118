// ScreenRecorder: captures the screen (getDisplayMedia) plus microphone
// (getUserMedia), merges both into one MediaStream, records it with a single
// MediaRecorder and persists every timeslice chunk into IndexedDB.
//
// - pause()/resume() never discard chunks; the MediaRecorder timeline stays
//   continuous while paused wall-clock time is excluded from `activeMs`.
// - After a browser reload, `recover()` reloads persisted chunks and a new
//   MediaRecorder segment continues the session; at download time all
//   segments are remuxed into one WebM with continuous timecodes.

import { RecorderStore } from './db.js';
import { parseWebm, remuxSegments } from './ebml.js';

const TIMESLICE_MS = 1000;
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMimeType() {
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export class ScreenRecorder extends EventTarget {
  constructor() {
    super();
    this.store = new RecorderStore();
    this.state = 'idle'; // idle | recording | paused | stopped
    this.stream = null;
    this.recorder = null;
    this.segment = 0;
    this.seq = 0;
    this.savedActiveMs = 0;
    this.resumedAt = 0;
    // segment index -> array of Blob (in-memory mirror of IndexedDB chunks)
    this.segmentBlobs = new Map();
    this.recoveryInfo = null;
  }

  async init() {
    await this.store.open();
    const session = await this.store.getSession();
    if (session && (session.state === 'recording' || session.state === 'paused')) {
      const chunks = await this.store.getAllChunks();
      for (const chunk of chunks) {
        if (!this.segmentBlobs.has(chunk.segment)) {
          this.segmentBlobs.set(chunk.segment, []);
        }
        this.segmentBlobs.get(chunk.segment).push(chunk.blob);
      }
      this.segment = session.segment;
      this.seq = session.seq;
      this.savedActiveMs = session.activeMs || 0;
      this.recoveryInfo = {
        chunks: chunks.length,
        bytes: chunks.reduce((sum, c) => sum + c.size, 0),
        segments: this.segmentBlobs.size,
        activeMs: this.savedActiveMs,
      };
      this.state = 'paused';
      await this.refreshBlockCounts();
    }
    this.emit();
    return this.recoveryInfo;
  }

  get activeMs() {
    if (this.state === 'recording') {
      return this.savedActiveMs + (performance.now() - this.resumedAt);
    }
    return this.savedActiveMs;
  }

  emit() {
    this.dispatchEvent(new CustomEvent('change', { detail: this.getStats() }));
  }

  async acquireMedia() {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    const tracks = [...display.getVideoTracks(), ...mic.getAudioTracks()];
    this.stream = new MediaStream(tracks);
  }

  async start() {
    // Fresh start: wipe any previous session unless we are recovering one.
    if (!this.recoveryInfo) {
      await this.store.clear();
      this.segmentBlobs.clear();
      this.segment = 0;
      this.seq = 0;
      this.savedActiveMs = 0;
    } else {
      // Recovery after reload: continue in a new segment.
      this.segment += 1;
    }
    await this.acquireMedia();
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: 2_500_000,
      audioBitsPerSecond: 128_000,
    });
    this.recorder.ondataavailable = (event) => this.onChunk(event);
    this.recorder.onstop = () => this.onStopped();
    this.recorder.start(TIMESLICE_MS);
    this.resumedAt = performance.now();
    this.state = 'recording';
    await this.persistSession();
    this.emit();
  }

  async onChunk(event) {
    if (!event.data || event.data.size === 0) return;
    this.seq += 1;
    const blob = event.data;
    if (!this.segmentBlobs.has(this.segment)) {
      this.segmentBlobs.set(this.segment, []);
    }
    this.segmentBlobs.get(this.segment).push(blob);
    await this.store.appendChunk({
      segment: this.segment,
      seq: this.seq,
      size: blob.size,
      type: blob.type,
      blob,
    });
    await this.persistSession();
    await this.refreshBlockCounts();
    this.emit();
  }

  async persistSession() {
    await this.store.saveSession({
      state: this.state,
      segment: this.segment,
      seq: this.seq,
      activeMs: Math.round(this.activeMs),
    });
  }

  pause() {
    if (this.state !== 'recording') return;
    // Flush the in-flight slice first so pausing never truncates data,
    // then pause: the recorder timeline stops advancing but every chunk
    // written so far stays untouched in IndexedDB.
    this.recorder.requestData();
    this.recorder.pause();
    this.savedActiveMs = this.activeMs;
    this.state = 'paused';
    this.persistSession().then(() => this.emit());
  }

  resume() {
    if (this.state !== 'paused' || !this.recorder) return;
    this.recorder.resume();
    this.resumedAt = performance.now();
    this.state = 'recording';
    this.persistSession().then(() => this.emit());
  }

  async stop() {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    if (this.state === 'recording') {
      this.savedActiveMs = this.activeMs;
    }
    this.state = 'stopped';
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop(); // final dataavailable fires before onstop
    } else {
      await this.persistSession();
      this.emit();
    }
  }

  async onStopped() {
    for (const track of this.stream.getTracks()) track.stop();
    this.stream = null;
    await this.persistSession();
    this.emit();
  }

  async discard() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    await this.store.clear();
    this.segmentBlobs.clear();
    this.recoveryInfo = null;
    this.segment = 0;
    this.seq = 0;
    this.savedActiveMs = 0;
    this.state = 'idle';
    this.emit();
  }

  async segmentStats(segmentIndex, blobs) {
    this.parseCache = this.parseCache || new Map();
    const cached = this.parseCache.get(segmentIndex);
    if (cached && cached.count === blobs.length) return cached.stats;
    const buffer = await new Blob(blobs).arrayBuffer();
    const parsed = parseWebm(buffer);
    const stats = {
      videoBlocks: parsed.videoBlocks,
      audioBlocks: parsed.audioBlocks,
    };
    this.parseCache.set(segmentIndex, { count: blobs.length, stats });
    return stats;
  }

  getStats() {
    let bytes = 0;
    let chunks = 0;
    for (const blobs of this.segmentBlobs.values()) {
      chunks += blobs.length;
      for (const blob of blobs) bytes += blob.size;
    }
    return {
      state: this.state,
      activeMs: this.activeMs,
      chunks,
      bytes,
      segment: this.segment,
      segments: this.segmentBlobs.size,
      videoBlocks: this.lastVideoBlocks || 0,
      audioBlocks: this.lastAudioBlocks || 0,
      recovery: this.recoveryInfo,
    };
  }

  // Recomputes video/audio block counts from the recorded WebM data.
  // Called on every chunk; cached per segment so only the live segment
  // is re-parsed.
  async refreshBlockCounts() {
    let videoBlocks = 0;
    let audioBlocks = 0;
    for (const [segmentIndex, blobs] of this.segmentBlobs) {
      const stats = await this.segmentStats(segmentIndex, blobs);
      videoBlocks += stats.videoBlocks;
      audioBlocks += stats.audioBlocks;
    }
    this.lastVideoBlocks = videoBlocks;
    this.lastAudioBlocks = audioBlocks;
    this.emit();
  }

  // Concatenates every segment in order and remuxes into one playable WebM
  // with continuous video/audio timecodes across reload boundaries.
  async buildFile() {
    const ordered = [...this.segmentBlobs.keys()].sort((a, b) => a - b);
    const buffers = [];
    for (const segmentIndex of ordered) {
      const blob = new Blob(this.segmentBlobs.get(segmentIndex), {
        type: 'video/webm',
      });
      buffers.push(await blob.arrayBuffer());
    }
    const merged = remuxSegments(buffers);
    return new Blob([merged], { type: 'video/webm' });
  }
}
