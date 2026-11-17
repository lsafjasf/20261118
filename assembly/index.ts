// Audio fingerprinting core (Shazam-style) compiled to WASM.
// Pipeline: PCM -> STFT -> log-freq spectral peaks -> time/freq hashes
// -> inverted index -> query with offset histogram -> top-3 candidates.

export const SAMPLE_RATE: i32 = 22050;
export const FRAME_SIZE: i32 = 2048;
export const HOP_SIZE: i32 = 512;
const LOG_BINS_PER_OCTAVE: i32 = 24;
const MIN_FREQ: f32 = 55.0;
const NUM_LOG_BINS: i32 = 176;
const TARGET_DT_MIN: i32 = 1;
const TARGET_DT_MAX: i32 = 32;
const TARGET_DF_MAX: i32 = 24;
const FAN_OUT: i32 = 4;

// ---------------------------------------------------------------- PCM input

let pcm: Float32Array = new Float32Array(0);

export function pcmAlloc(len: i32): i32 {
  pcm = new Float32Array(len);
  return changetype<i32>(pcm.dataStart);
}

// ---------------------------------------------------------------- FFT

let fftCos: Float32Array = new Float32Array(0);
let fftSin: Float32Array = new Float32Array(0);
let fftRev: Int32Array = new Int32Array(0);

function initFft(n: i32): void {
  if (fftCos.length == n) return;
  fftCos = new Float32Array(n / 2);
  fftSin = new Float32Array(n / 2);
  fftRev = new Int32Array(n);
  for (let i = 0; i < n / 2; i++) {
    fftCos[i] = f32(Math.cos(2.0 * Math.PI * f64(i) / f64(n)));
    fftSin[i] = f32(-Math.sin(2.0 * Math.PI * f64(i) / f64(n)));
  }
  let levels = 0;
  while ((1 << levels) < n) levels++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    fftRev[i] = r;
  }
}

// In-place iterative radix-2 FFT on separate re/im arrays.
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = fftRev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < half; j++) {
        const k = j * step;
        const cr = fftCos[k], ci = fftSin[k];
        const l = i + j + half;
        const tr = re[l] * cr - im[l] * ci;
        const ti = re[l] * ci + im[l] * cr;
        re[l] = re[i + j] - tr;
        im[l] = im[i + j] - ti;
        re[i + j] += tr;
        im[i + j] += ti;
      }
    }
  }
}
// ------------------------------------------------- STFT + log-freq peaks

let hann: Float32Array = new Float32Array(0);

function initHann(n: i32): void {
  if (hann.length == n) return;
  hann = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hann[i] = f32(0.5 - 0.5 * Math.cos(2.0 * Math.PI * f64(i) / f64(n - 1)));
  }
}

// Map linear FFT magnitude to log-frequency bins (max pooling per bin).
function toLogBins(re: Float32Array, im: Float32Array, out: Float32Array): void {
  const n = re.length;
  const sr = f32(SAMPLE_RATE);
  const logMin = f32(Math.log(f64(MIN_FREQ)));
  const octaves = f32(Math.log(0.5 * sr / MIN_FREQ) / Math.log(2.0));
  for (let b = 0; b < NUM_LOG_BINS; b++) out[b] = 0.0;
  for (let k = 1; k < n / 2; k++) {
    const f = f32(k) * sr / f32(n);
    if (f < MIN_FREQ) continue;
    const oct = f32(Math.log(f64(f)) - f64(logMin)) / f32(Math.log(2.0));
    let b = i32(oct / octaves * f32(NUM_LOG_BINS));
    if (b >= NUM_LOG_BINS) b = NUM_LOG_BINS - 1;
    const mag = Mathf.sqrt(re[k] * re[k] + im[k] * im[k]);
    if (mag > out[b]) out[b] = mag;
  }
}

// Peak-pick one frame's log-bin magnitudes into (bin, mag) pairs.
// A peak must be a local maximum in frequency and exceed an adaptive
// threshold derived from the frame's energy (noise robustness).
function pickPeaks(
  cur: Float32Array,
  prev: Float32Array,
  next: Float32Array,
  binsOut: Int32Array,
  magsOut: Float32Array
): i32 {
  let mean: f32 = 0.0;
  for (let b = 0; b < NUM_LOG_BINS; b++) mean += cur[b];
  mean /= f32(NUM_LOG_BINS);
  const threshold = mean * 3.0;
  let count = 0;
  for (let b = 1; b < NUM_LOG_BINS - 1 && count < binsOut.length; b++) {
    const m = cur[b];
    if (m < threshold) continue;
    if (m <= cur[b - 1] || m < cur[b + 1]) continue;
    if (m < prev[b] || m <= next[b]) continue;
    binsOut[count] = b;
    magsOut[count] = m;
    count++;
  }
  // Keep only the strongest peaks per frame: noise adds many weak peaks,
  // while musical peaks dominate the magnitude ranking.
  const keep = min(count, 8);
  for (let i = 0; i < keep; i++) {
    let best = i;
    for (let j = i + 1; j < count; j++) {
      if (magsOut[j] > magsOut[best]) best = j;
    }
    if (best != i) {
      const tm = magsOut[i]; magsOut[i] = magsOut[best]; magsOut[best] = tm;
      const tb = binsOut[i]; binsOut[i] = binsOut[best]; binsOut[best] = tb;
    }
  }
  return keep;
}

// Extract all spectral peaks of the current pcm buffer.
// Returns packed frames: frameCount, and fills peakBins/peakFrames.
let peakBins = new Int32Array(0);
let peakFrames = new Int32Array(0);

function extractPeaks(): i32 {
  initFft(FRAME_SIZE);
  initHann(FRAME_SIZE);
  const nFrames = max(0, (pcm.length - FRAME_SIZE) / HOP_SIZE + 1);
  const maxPeaksPerFrame = 16;
  peakBins = new Int32Array(nFrames * maxPeaksPerFrame);
  peakFrames = new Int32Array(nFrames * maxPeaksPerFrame);
  const re = new Float32Array(FRAME_SIZE);
  const im = new Float32Array(FRAME_SIZE);
  const prevBins = new Float32Array(NUM_LOG_BINS);
  const curBins = new Float32Array(NUM_LOG_BINS);
  const nextBins = new Float32Array(NUM_LOG_BINS);
  const frameBins = new Int32Array(maxPeaksPerFrame);
  const frameMags = new Float32Array(maxPeaksPerFrame);
  let total = 0;
  for (let b = 0; b < NUM_LOG_BINS; b++) {
    prevBins[b] = 0.0;
    curBins[b] = 0.0;
  }
  for (let t = 0; t < nFrames; t++) {
    const off = t * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      re[i] = pcm[off + i] * hann[i];
      im[i] = 0.0;
    }
    fft(re, im);
    toLogBins(re, im, nextBins);
    if (t >= 1) {
      const cnt = pickPeaks(curBins, prevBins, nextBins, frameBins, frameMags);
      for (let p = 0; p < cnt; p++) {
        peakBins[total] = frameBins[p];
        peakFrames[total] = t - 1;
        total++;
      }
    }
    for (let b = 0; b < NUM_LOG_BINS; b++) {
      prevBins[b] = curBins[b];
      curBins[b] = nextBins[b];
    }
  }
  return total;
}
// ------------------------------------------------- hashing + inverted index

// Hash packs (anchorBin, targetBin, dt): 8 + 8 + 6 bits.
function makeHash(f1: i32, f2: i32, dt: i32): u32 {
  return (u32(f1 & 0xff) << 14) | (u32(f2 & 0xff) << 6) | u32(dt & 0x3f);
}

// Index value packs (songId, frame): 8 + 24 bits.
function makeIndexValue(songId: i32, frame: i32): u32 {
  return (u32(songId & 0xff) << 24) | u32(frame & 0xffffff);
}

const indexMap = new Map<u32, Array<u32>>();

export function resetIndex(): void {
  indexMap.clear();
}

export function indexSong(songId: i32): i32 {
  const total = extractPeaks();
  let hashCount = 0;
  for (let i = 0; i < total; i++) {
    const t1 = peakFrames[i];
    const f1 = peakBins[i];
    let used = 0;
    for (let j = i + 1; j < total && used < FAN_OUT; j++) {
      const dt = peakFrames[j] - t1;
      if (dt < TARGET_DT_MIN) continue;
      if (dt > TARGET_DT_MAX) break;
      const df = peakBins[j] - f1;
      if (df < -TARGET_DF_MAX || df > TARGET_DF_MAX) continue;
      const h = makeHash(f1, peakBins[j], dt);
      let arr: Array<u32>;
      if (indexMap.has(h)) {
        arr = indexMap.get(h);
      } else {
        arr = new Array<u32>();
        indexMap.set(h, arr);
      }
      arr.push(makeIndexValue(songId, t1));
      used++;
      hashCount++;
    }
  }
  return hashCount;
}

// ------------------------------------------------- query

let resultSongIds = new Int32Array(3);
let resultOffsets = new Int32Array(3); // in frames
let resultMatches = new Int32Array(3);
let resultQueryHashes: i32 = 0;

// Query current pcm against the index. binShift (in log bins) lets the
// host test pitch-shift hypotheses without resampling.
// Returns number of candidates (0..3).
export function query(binShift: i32): i32 {
  const total = extractPeaks();
  const offsets = new Map<i64, i32>();
  let queryHashes = 0;
  for (let i = 0; i < total; i++) {
    const t1 = peakFrames[i];
    const f1 = peakBins[i] + binShift;
    if (f1 < 0 || f1 >= NUM_LOG_BINS) continue;
    let used = 0;
    for (let j = i + 1; j < total && used < FAN_OUT; j++) {
      const dt = peakFrames[j] - t1;
      if (dt < TARGET_DT_MIN) continue;
      if (dt > TARGET_DT_MAX) break;
      const f2 = peakBins[j] + binShift;
      const df = f2 - f1;
      if (df < -TARGET_DF_MAX || df > TARGET_DF_MAX) continue;
      queryHashes++;
      // Tolerate +/-1 frame of dt jitter: noise and resampling shift peak
      // times slightly, so probe the neighboring hash values too.
      for (let dd = -1; dd <= 1; dd++) {
        const dtq = dt + dd;
        if (dtq < TARGET_DT_MIN || dtq > TARGET_DT_MAX) continue;
        const h = makeHash(f1, f2, dtq);
        if (!indexMap.has(h)) continue;
        const hits = indexMap.get(h);
        for (let k = 0; k < hits.length; k++) {
          const v = hits[k];
          const songId = i32(v >>> 24);
          const songFrame = i32(v & 0xffffff);
          // 2-frame offset buckets: noise jitters peak frames by +/-1,
          // and true votes should still land in the same bucket.
          const bucket = ((songFrame - t1) >> 1) + 0x400000;
          const key = (i64(songId) << 40) | i64(bucket);
          offsets.set(key, offsets.has(key) ? offsets.get(key) + 1 : 1);
        }
      }
      used++;
    }
  }
  resultQueryHashes = queryHashes;
  // Pick top-3 distinct (songId, offset) buckets.
  let count = 0;
  const keys = offsets.keys();
  for (let round = 0; round < 3; round++) {
    let bestKey: i64 = -1;
    let bestVal = 0;
    for (let k = 0; k < keys.length; k++) {
      const v = offsets.get(keys[k]);
      if (v > bestVal) {
        let taken = false;
        for (let r = 0; r < count; r++) {
          if (resultSongIds[r] == i32(keys[k] >>> 40) &&
              resultOffsets[r] == (i32(keys[k] & 0xffffffffff) - 0x400000) << 1) {
            taken = true;
            break;
          }
        }
        if (!taken) { bestVal = v; bestKey = keys[k]; }
      }
    }
    if (bestKey < 0 || bestVal == 0) break;
    resultSongIds[count] = i32(bestKey >>> 40);
    resultOffsets[count] = (i32(bestKey & 0xffffffffff) - 0x400000) << 1;
    resultMatches[count] = bestVal;
    count++;
  }
  return count;
}

export function getResultSongId(i: i32): i32 { return resultSongIds[i]; }
export function getResultOffset(i: i32): i32 { return resultOffsets[i]; }
export function getResultMatches(i: i32): i32 { return resultMatches[i]; }
export function getQueryHashes(): i32 { return resultQueryHashes; }
