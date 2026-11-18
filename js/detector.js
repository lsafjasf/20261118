// Shot boundary detection: HSV color histogram + Sobel edge features,
// adaptive dual thresholds, gradual-transition grouping, min-shot-length
// suppression. Pure functions so they can run inside a Web Worker.

// 128 color bins (H8 x S4 x V4) + 1 black bin + 4 gray bins.
// Hue/saturation are meaningless for near-black or gray pixels, so those
// collapse into dedicated bins (avoids wild histogram swings in dark fades).
export const HIST_BINS = 8 * 4 * 4 + 5;
const BLACK_BIN = 128;
const GRAY_BIN = 129;

export function extractFeatures(pixels, width, height) {
  const hist = new Float32Array(HIST_BINS);
  const luma = new Uint8Array(width * height);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const y = (r * 77 + g * 150 + b * 29) >> 8;
    luma[i] = y;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const v = max / 255;
    const s = max === 0 ? 0 : d / max;
    let bin;
    if (v < 0.12) {
      bin = BLACK_BIN;
    } else if (s < 0.12) {
      bin = GRAY_BIN + Math.min(3, (v * 4) | 0);
    } else {
      let h = 0;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      const hb = Math.min(7, (h / 45) | 0);
      const sb = Math.min(3, (s * 4) | 0);
      const vb = Math.min(3, (v * 4) | 0);
      bin = hb * 16 + sb * 4 + vb;
    }
    hist[bin] += 1 / n;
  }

  // Sobel edge map on luma
  const edges = new Uint8Array(n);
  let edgeCount = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -luma[i - width - 1] - 2 * luma[i - 1] - luma[i + width - 1] +
        luma[i - width + 1] + 2 * luma[i + 1] + luma[i + width + 1];
      const gy =
        -luma[i - width - 1] - 2 * luma[i - width] - luma[i - width + 1] +
        luma[i + width - 1] + 2 * luma[i + width] + luma[i + width + 1];
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag > 96) {
        edges[i] = 1;
        edgeCount++;
      }
    }
  }
  return { hist, edges, edgeCount };
}

export function frameDiff(prev, curr) {
  let inter = 0;
  for (let i = 0; i < HIST_BINS; i++) {
    inter += Math.min(prev.hist[i], curr.hist[i]);
  }
  const histDist = 1 - inter;

  // Asymmetric edge change: motion makes edges vanish AND appear at once,
  // while fades only add edges (fade-in) or only remove them (fade-out).
  let appeared = 0;
  let vanished = 0;
  const n = prev.edges.length;
  for (let i = 0; i < n; i++) {
    if (curr.edges[i] && !prev.edges[i]) appeared++;
    else if (prev.edges[i] && !curr.edges[i]) vanished++;
  }
  const floor = 0.02 * n;
  const edgeAppear = appeared / Math.max(curr.edgeCount, floor);
  const edgeVanish = vanished / Math.max(prev.edgeCount, floor);
  const edgeChange = Math.min(1, Math.max(edgeAppear, edgeVanish));

  return {
    histDist,
    edgeChange,
    edgeAppear,
    edgeVanish,
    score: 0.7 * histDist + 0.3 * edgeChange,
  };
}

function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// samples: [{time, score, histDist, edgeChange}] (diff vs previous sample).
// Hard cuts: combined score spikes. Gradual transitions: sustained color
// drift while edges stay put (fades/dissolves keep scene structure, fast
// motion does not — that is how we reject motion false alarms).
// options: {minShotLen, hardFloor, lowFloor, accMin, edgeGate}
export function detectBoundaries(samples, options = {}) {
  const minShotLen = options.minShotLen ?? 0.5;
  const edgeGate = options.edgeGate ?? 0.35;
  const sorted = samples.map((s) => s.score).sort((a, b) => a - b);
  const med = sorted.length ? median(sorted) : 0;
  const absDev = sorted.map((s) => Math.abs(s - med)).sort((a, b) => a - b);
  const mad = sorted.length ? median(absDev) : 0;

  const tHigh = Math.max(options.hardFloor ?? 0.45, med + 6 * mad);
  const tLow = options.lowFloor ?? 0.05; // per-step histogram drift floor
  const tAcc = options.accMin ?? 0.3; // accumulated drift needed for a fade

  const boundaries = [];
  let run = null;
  let skips = 0;
  // A lone abrupt jump on a static scene may be the first step of a fade
  // (e.g. black -> 10% brightness). Hold it as pending: if the drift
  // continues it becomes a gradual run, otherwise it was a true cut.
  let pending = null;

  const closeRun = () => {
    if (!run) return;
    if (run.count >= 2 && run.sum >= tAcc) {
      boundaries.push({
        time: (run.start + run.end) / 2,
        type: 'gradual',
        confidence: clamp01(0.35 + run.sum / (4 * tAcc)),
        score: run.sum,
        spanStart: run.start,
        spanEnd: run.end,
      });
    }
    run = null;
    skips = 0;
  };

  const joinRun = (time, drift) => {
    if (!run) run = { start: time, end: time, sum: 0, count: 0 };
    run.end = time;
    run.sum += drift;
    run.count++;
    skips = 0;
  };

  const emitHard = (s) => {
    boundaries.push({
      time: s.time,
      type: 'hard',
      confidence: clamp01(0.5 + ((s.score - tHigh) / tHigh) * 0.5),
      score: s.score,
      spanStart: s.time,
      spanEnd: s.time,
    });
  };

  for (const s of samples) {
    if (pending) {
      if (s.histDist >= tLow) {
        // drift continues: the pending jump was a fade head
        run = { start: pending.time, end: pending.time, sum: pending.histDist, count: 1 };
        skips = 0;
      } else {
        emitHard(pending);
      }
      pending = null;
    }
    // scene structure is preserved when edges only appear (fade-in) or
    // only vanish (fade-out); motion makes both happen simultaneously
    const staticScene = Math.min(s.edgeAppear, s.edgeVanish) < edgeGate;
    const abrupt = s.score >= tHigh || s.histDist >= tHigh;
    // a big step right after a sustained drift is the fade completing:
    // absorb it into the gradual run instead of calling it a hard cut
    const fadeTail = run && s.time - run.end <= 0.3;
    if (abrupt && !fadeTail) {
      if (staticScene) {
        pending = { time: s.time, score: s.score, histDist: s.histDist };
      } else {
        closeRun();
        emitHard(s);
      }
    } else if ((staticScene || (abrupt && fadeTail)) && s.histDist >= tLow) {
      // color drifts but edges stay put: fade / dissolve in progress
      // (also absorbs the final big step of a fade into its run)
      joinRun(s.time, s.histDist);
    } else if (run && skips < 1 && s.histDist >= tLow / 2) {
      // tolerate a single weak sample inside a run
      skips++;
      joinRun(s.time, s.histDist);
    } else {
      closeRun();
    }
  }
  closeRun();
  if (pending) emitHard(pending);

  // Enforce minimum shot length: drop the weaker of any too-close pair.
  boundaries.sort((a, b) => a.time - b.time);
  let i = 0;
  while (i < boundaries.length - 1) {
    if (boundaries[i + 1].time - boundaries[i].time < minShotLen) {
      const drop = boundaries[i].confidence < boundaries[i + 1].confidence ? i : i + 1;
      boundaries.splice(drop, 1);
      i = Math.max(0, i - 1);
    } else {
      i++;
    }
  }

  return { boundaries, thresholds: { tHigh, tLow, tAcc, median: med, mad } };
}

// Build shot list from boundaries and total duration.
export function buildShots(boundaries, duration) {
  const shots = [];
  let start = 0;
  for (const b of boundaries) {
    shots.push({ start, end: b.time, inType: shots.length === 0 ? null : b.type });
    start = b.time;
  }
  shots.push({ start, end: duration, inType: shots.length === 0 ? null : boundaries[boundaries.length - 1]?.type });
  return shots.map((s, i) => ({
    index: i,
    start: s.start,
    end: s.end,
    duration: s.end - s.start,
    repTime: (s.start + s.end) / 2,
    inType: s.inType,
  }));
}
