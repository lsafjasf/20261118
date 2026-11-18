// Web Worker: demux MP4, decode with WebCodecs, sample frames at a fixed
// interval, extract histogram/edge features and detect shot boundaries.
import { demux, sampleData } from './demuxer.js';
import { extractFeatures, frameDiff, detectBoundaries, buildShots } from './detector.js';

const SAMPLE_W = 96;
const SAMPLE_H = 54;

let canvas = null;
let ctx = null;
let lastSampled = [];

function ensureCanvas() {
  if (!canvas) {
    canvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
}

async function waitForQueue(decoder, max) {
  while (decoder.decodeQueueSize > max) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function runDetection(fileBuffer, options, post) {
  const track = demux(fileBuffer);
  post({ type: 'info', codec: track.codec, duration: track.duration, samples: track.samples.length });

  const interval = options.interval ?? 0.1;
  const minShotLen = options.minShotLen ?? 0.5;

  ensureCanvas();
  const sampled = []; // {time, data(Uint8ClampedArray), features}
  const diffs = []; // {time, score}
  let prevFeatures = null;
  let nextSample = 0;
  let decoded = 0;
  let decodeError = null;

  const decoder = new VideoDecoder({
    output: (vf) => {
      try {
        const t = vf.timestamp / 1e6;
        if (t + 1e-6 >= nextSample) {
          ctx.drawImage(vf, 0, 0, SAMPLE_W, SAMPLE_H);
          const img = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
          const features = extractFeatures(img.data, SAMPLE_W, SAMPLE_H);
          if (prevFeatures) {
            const d = frameDiff(prevFeatures, features);
            diffs.push({
              time: t,
              score: d.score,
              histDist: d.histDist,
              edgeChange: d.edgeChange,
              edgeAppear: d.edgeAppear,
              edgeVanish: d.edgeVanish,
            });
          }
          prevFeatures = features;
          sampled.push({ time: t, data: img.data });
          nextSample += interval;
        }
      } finally {
        vf.close();
        decoded++;
        if (decoded % 15 === 0) {
          post({ type: 'progress', decoded, total: track.samples.length });
        }
      }
    },
    error: (e) => {
      decodeError = e;
    },
  });

  decoder.configure({
    codec: track.codec,
    description: track.description ?? undefined,
    hardwareAcceleration: 'prefer-software',
  });

  for (const s of track.samples) {
    if (decodeError) break;
    await waitForQueue(decoder, 40);
    decoder.decode(new EncodedVideoChunk({
      type: s.key ? 'key' : 'delta',
      timestamp: Math.round((s.cts * 1e6) / track.timescale),
      duration: Math.round(1e6 / 30),
      data: sampleData(track, s),
    }));
  }
  await decoder.flush().catch(() => {});
  decoder.close();
  if (decodeError) throw new Error(`decode failed: ${decodeError.message || decodeError}`);
  post({ type: 'progress', decoded, total: track.samples.length });

  const { boundaries, thresholds } = detectBoundaries(diffs, { minShotLen });
  const shots = buildShots(boundaries, track.duration);
  lastSampled = sampled;

  // Representative frame thumbnails (transferred as raw RGBA buffers).
  const transfers = [];
  for (const shot of shots) {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < sampled.length; k++) {
      const d = Math.abs(sampled[k].time - shot.repTime);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    const buf = sampled[best].data.buffer.slice(0);
    shot.thumb = buf;
    shot.thumbW = SAMPLE_W;
    shot.thumbH = SAMPLE_H;
    transfers.push(buf);
  }

  post({
    type: 'result',
    duration: track.duration,
    interval,
    minShotLen,
    thresholds,
    diffs,
    boundaries,
    shots,
  }, transfers);
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'detect') {
    try {
      await runDetection(msg.file, msg.options || {}, (m, transfers) => self.postMessage(m, transfers || []));
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message ? err.message : err) });
    }
  } else if (msg.type === 'thumbs') {
    const thumbs = [];
    const transfers = [];
    for (const t of msg.times) {
      let best = null;
      let bestD = Infinity;
      for (const s of lastSampled) {
        const d = Math.abs(s.time - t);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best) {
        const buf = best.data.buffer.slice(0);
        thumbs.push({ data: buf, width: SAMPLE_W, height: SAMPLE_H });
        transfers.push(buf);
      } else {
        thumbs.push(null);
      }
    }
    self.postMessage({ type: 'thumbs', reqId: msg.reqId, thumbs }, transfers);
  }
};
