import { decodeDatagram, KIND_VIDEO, KIND_AUDIO } from '/protocol.js';
import { ReorderBuffer } from '/reorder.js';

const TIERS = { low: 80, mid: 200, high: 450 };
// A decode counts as "late" (stale frame being chased) only if it finishes
// more than one frame interval past its play-out deadline.
const LATE_TOLERANCE = { [KIND_VIDEO]: 40, [KIND_AUDIO]: 25 };
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const logEl = $('log');
const log = (m) => {
  logEl.textContent += `${new Date().toISOString().slice(11, 23)} ${m}\n`;
  console.log(m);
};

const state = {
  wt: null,
  audioCtx: null,
  videoDecoder: null,
  audioDecoder: null,
  buffers: {},
  pending: { [KIND_VIDEO]: [], [KIND_AUDIO]: [] },
  reasm: new Map(),
  latest: { [KIND_VIDEO]: {}, [KIND_AUDIO]: {} },
  lateDecodes: { [KIND_VIDEO]: 0, [KIND_AUDIO]: 0 },
  played: { [KIND_VIDEO]: 0, [KIND_AUDIO]: 0 },
  heap: { start: 0, max: 0, end: 0 },
  ended: false,
  runConfig: null,
  needKey: false,
  syncSkipped: 0,
  t0: null,
};

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readJsonObjects(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const objects = [];
  const take = () => {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          objects.push(JSON.parse(buf.slice(start, i + 1)));
          buf = buf.slice(i + 1);
          return true;
        }
      }
    }
    return false;
  };
  return {
    async next() {
      for (;;) {
        if (take()) return objects.shift();
        const { done, value } = await reader.read();
        if (done) return null;
        buf += decoder.decode(value, { stream: true });
      }
    },
  };
}

function makeBuffer(kind, bufferMs, onEmit) {
  return new ReorderBuffer({
    name: kind === KIND_VIDEO ? 'video' : 'audio',
    bufferMs,
    frameIntervalMs: kind === KIND_VIDEO ? 1000 / 30 : 20,
    onEmit,
    onExpire: (frame, reason) => {
      // Dropped video frames break the prediction chain: resync at next keyframe.
      if (kind === KIND_VIDEO) state.needKey = true;
      if (state.runConfig?.verbose) log(`expire ${kind} seq=${frame.seq} ${reason}`);
    },
  });
}

function handleDatagram(data) {
  const d = decodeDatagram(data);
  const key = `${d.kind}:${d.seq}`;
  let entry = state.reasm.get(key);
  if (!entry) {
    entry = { chunks: new Array(d.chunkCount), got: 0, pts: d.pts, sendTs: 0 };
  entry.flags = d.flags;
    state.reasm.set(key, entry);
  }
  if (!entry.chunks[d.chunkIdx]) {
    entry.chunks[d.chunkIdx] = d.payload;
    entry.got++;
  }
  entry.sendTs = Math.max(entry.sendTs, d.sendTs);
  if (entry.got !== entry.chunks.length) return;
  state.reasm.delete(key);
  let size = 0;
  for (const c of entry.chunks) size += c.byteLength;
  const payload = new Uint8Array(size);
  let off = 0;
  for (const c of entry.chunks) {
    payload.set(c, off);
    off += c.byteLength;
  }
  const buffer = state.buffers[d.kind];
  buffer.stats.received++;
  buffer.push(
    {
      seq: d.seq,
      pts: d.pts,
      sendTs: entry.sendTs,
      recvTs: Date.now(),
      data: payload,
      size,
      isKey: (entry.flags & 1) === 1,
    },
    Date.now()
  );
}

// --- decoders -------------------------------------------------------------

function setupVideoDecoder(config) {
  const canvas = $('video');
  const ctx2d = canvas.getContext('2d');
  state.videoDecoder = new VideoDecoder({
    output: (frame) => {
      const meta = state.pending[KIND_VIDEO].shift();
      const decodeDone = Date.now();
      if (meta) {
        const decodeMs = performance.now() - meta.decodeStart;
        const late = decodeDone - meta.playAt;
        if (late > LATE_TOLERANCE[KIND_VIDEO]) state.lateDecodes[KIND_VIDEO]++;
        state.latest[KIND_VIDEO] = {
          sendTs: meta.sendTs,
          recvTs: meta.recvTs,
          decTs: decodeDone,
          decMs: decodeMs,
          e2e: decodeDone - meta.sendTs,
        };
        const wait = Math.max(0, meta.playAt - Date.now());
        setTimeout(() => {
          ctx2d.drawImage(frame, 0, 0, canvas.width, canvas.height);
          frame.close();
          state.played[KIND_VIDEO]++;
        }, wait);
      } else {
        frame.close();
      }
    },
    error: (e) => {
      log(`video decoder error: ${e.message}`);
      state.needKey = true;
      state.pending[KIND_VIDEO] = [];
      try {
        state.videoDecoder.reset();
        state.videoDecoder.configure(state.videoConfig);
      } catch {}
    },
  });
  state.videoConfig = config;
  state.videoDecoder.configure(config);
}

function setupAudioDecoder(config) {
  state.audioDecoder = new AudioDecoder({
    output: (audioData) => {
      const meta = state.pending[KIND_AUDIO].shift();
      const decodeDone = Date.now();
      if (meta) {
        const decodeMs = performance.now() - meta.decodeStart;
        const late = decodeDone - meta.playAt;
        if (late > LATE_TOLERANCE[KIND_AUDIO]) state.lateDecodes[KIND_AUDIO]++;
        state.latest[KIND_AUDIO] = {
          sendTs: meta.sendTs,
          recvTs: meta.recvTs,
          decTs: decodeDone,
          decMs: decodeMs,
          e2e: decodeDone - meta.sendTs,
        };
        scheduleAudio(audioData, meta.playAt);
      } else {
        audioData.close();
      }
    },
    error: (e) => log(`audio decoder error: ${e.message}`),
  });
  state.audioDecoder.configure(config);
}

function scheduleAudio(audioData, playAt) {
  const ctx = state.audioCtx;
  if (!ctx || ctx.state !== 'running') {
    audioData.close();
    state.played[KIND_AUDIO]++;
    return;
  }
  const frames = audioData.numberOfFrames;
  const buffer = ctx.createBuffer(audioData.numberOfChannels, frames, audioData.sampleRate);
  for (let ch = 0; ch < audioData.numberOfChannels; ch++) {
    const dst = buffer.getChannelData(ch);
    audioData.copyTo(dst, { planeIndex: ch });
  }
  audioData.close();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const when = Math.max(ctx.currentTime, ctx.currentTime + (playAt - Date.now()) / 1000);
  src.start(when);
  state.played[KIND_AUDIO]++;
}

// --- emit / decode ----------------------------------------------------------

function emitFrame(kind) {
  return (frame) => {
    const playAt =
      state.buffers[kind].anchor + frame.pts + state.buffers[kind].bufferMs;
    const tsUs = Math.round(frame.pts * 1000);
    if (kind === KIND_VIDEO) {
      if (state.needKey && !frame.isKey) {
        state.syncSkipped++;
        return;
      }
      state.needKey = false;
      state.pending[kind].push({
        ...frame,
        playAt,
        decodeStart: performance.now(),
      });
      state.videoDecoder.decode(
        new EncodedVideoChunk({
          type: frame.isKey ? 'key' : 'delta',
          timestamp: tsUs,
          duration: 1e6 / 30,
          data: frame.data,
        })
      );
    } else {
      state.pending[kind].push({
        ...frame,
        playAt,
        decodeStart: performance.now(),
      });
      state.audioDecoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: tsUs,
          duration: 20000,
          data: frame.data,
        })
      );
    }
  };
}

// --- run --------------------------------------------------------------------

async function run(config) {
  state.runConfig = config;
  $('status').textContent = 'connecting…';
  const { sha256Hex } = await (await fetch('/api/cert-hash')).json();
  const wt = new WebTransport('https://127.0.0.1:4434/media', {
    serverCertificateHashes: [{ algorithm: 'sha-256', value: hexToBytes(sha256Hex) }],
  });
  state.wt = wt;
  await wt.ready;
  log('WebTransport connected');
  $('status').textContent = 'receiving';

  const stream = await wt.createBidirectionalStream();
  const writer = stream.writable.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(config)));
  await writer.close();

  const messages = readJsonObjects(stream.readable);
  const serverConfig = await messages.next();
  log(`server config: video=${serverConfig.video.config.codec} audio=${serverConfig.audio.config.codec}`);

  const fixDesc = (cfg) =>
    cfg && cfg.description ? { ...cfg, description: b64ToBytes(cfg.description) } : cfg;
  setupVideoDecoder(fixDesc(serverConfig.video.config));
  setupAudioDecoder(fixDesc(serverConfig.audio.config));
  state.audioCtx = new AudioContext();
  state.audioCtx.resume().catch(() => {});

  state.buffers[KIND_VIDEO] = makeBuffer(KIND_VIDEO, config.bufferMs, emitFrame(KIND_VIDEO));
  state.buffers[KIND_AUDIO] = makeBuffer(KIND_AUDIO, config.bufferMs, emitFrame(KIND_AUDIO));

  const tickTimer = setInterval(() => {
    const now = Date.now();
    state.buffers[KIND_VIDEO]?.tick(now);
    state.buffers[KIND_AUDIO]?.tick(now);
  }, 5);
  state.heap.start = performance.memory?.usedJSHeapSize ?? 0;
  const heapTimer = setInterval(() => {
    const used = performance.memory?.usedJSHeapSize ?? 0;
    state.heap.max = Math.max(state.heap.max, used);
    state.heap.end = used;
  }, 250);

  (async () => {
    const reader = wt.datagrams.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handleDatagram(value);
    }
  })().catch((e) => log(`datagram reader: ${e.message}`));

  const endMsg = await messages.next();
  log(`server end: ${JSON.stringify(endMsg)}`);
  // Drain: keep ticking until both buffers are empty (or 3s grace).
  const drainDeadline = Date.now() + 3000;
  await new Promise((resolve) => {
    const check = setInterval(() => {
      const v = state.buffers[KIND_VIDEO];
      const a = state.buffers[KIND_AUDIO];
      if ((v.frames.size === 0 && a.frames.size === 0) || Date.now() > drainDeadline) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });
  clearInterval(tickTimer);
  clearInterval(heapTimer);
  await new Promise((r) => setTimeout(r, 600));
  finalize(endMsg);
}

function kindStats(kind) {
  const b = state.buffers[kind];
  return {
    received: b.stats.received,
    emitted: b.stats.emitted,
    expired: b.stats.expired,
    maxBufferedFrames: b.stats.maxBufferedFrames,
    maxBufferedBytes: b.stats.maxBufferedBytes,
    maxBurst: b.stats.maxBurst,
    capFrames: b.capFrames,
    lateDecodes: state.lateDecodes[kind],
    played: state.played[kind],
    syncSkipped: kind === KIND_VIDEO ? state.syncSkipped : 0,
  };
}

function finalize(endMsg) {
  state.ended = true;
  $('status').textContent = 'done';
  const result = {
    config: state.runConfig,
    video: kindStats(KIND_VIDEO),
    audio: kindStats(KIND_AUDIO),
    heap: state.heap,
    server: endMsg,
  };
  window.__result = result;
  log(`result: ${JSON.stringify(result)}`);
}

// --- UI ---------------------------------------------------------------------

function fmt(v, digits = 0) {
  return typeof v === 'number' ? v.toFixed(digits) : '-';
}

setInterval(() => {
  for (const [kind, p] of [
    [KIND_VIDEO, 'v'],
    [KIND_AUDIO, 'a'],
  ]) {
    const l = state.latest[kind];
    if (l.sendTs && !state.t0) state.t0 = l.sendTs;
    const rel = (ts) => (ts && state.t0 ? fmt(ts - state.t0, 0) : '-');
    $(`${p}-send`).textContent = rel(l.sendTs);
    $(`${p}-recv`).textContent = rel(l.recvTs);
    $(`${p}-dec`).textContent = rel(l.decTs);
    $(`${p}-decms`).textContent = fmt(l.decMs, 2);
    $(`${p}-e2e`).textContent = fmt(l.e2e, 0);
    const b = state.buffers[kind];
    if (b) {
      $(`${p}-recv-n`).textContent = b.stats.received;
      $(`${p}-dec-n`).textContent = b.stats.emitted;
      $(`${p}-exp`).textContent = b.stats.expired;
      $(`${p}-late`).textContent = state.lateDecodes[kind];
      $(`${p}-burst`).textContent = b.stats.maxBurst;
      $(`${p}-buf`).textContent = b.stats.maxBufferedFrames;
      $(`${p}-bufb`).textContent = b.stats.maxBufferedBytes;
    }
  }
  const mb = (n) => (n / 1048576).toFixed(1);
  $('heap0').textContent = mb(state.heap.start);
  $('heapMax').textContent = mb(state.heap.max);
  $('heap1').textContent = mb(state.heap.end);
}, 250);

function currentConfig() {
  const tier = document.querySelector('input[name=tier]:checked').value;
  return {
    tier,
    bufferMs: TIERS[tier],
    jitterMs: Number($('jitter').value),
    spikeMs: Number($('spike').value),
    spikeProb: Number($('spikeProb').value) / 100,
    durationMs: Number($('duration').value),
    seed: 42,
  };
}

$('start').addEventListener('click', () => {
  $('start').disabled = true;
  run(currentConfig()).catch((e) => {
    log(`run failed: ${e.message}`);
    $('status').textContent = `error: ${e.message}`;
    window.__result = { error: e.message };
  });
});

if (params.get('auto') === '1') {
  const tier = params.get('tier') ?? 'mid';
  document.querySelector(`input[name=tier][value=${tier}]`).checked = true;
  if (params.get('jitter')) $('jitter').value = params.get('jitter');
  if (params.get('spike')) $('spike').value = params.get('spike');
  if (params.get('spikeProb')) $('spikeProb').value = params.get('spikeProb');
  if (params.get('duration')) $('duration').value = params.get('duration');
  $('start').click();
}
