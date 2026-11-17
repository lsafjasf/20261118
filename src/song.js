// Deterministic synthetic song generator + query-variant transforms.
// Shared by the Node test harness and the browser UI (ES module).

export const SAMPLE_RATE = 22050;

// Seeded PRNG (mulberry32) so songs are reproducible.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// Additive note with decay envelope and a few harmonics.
function addNote(out, start, dur, midi, vel, rng, brightness) {
  const sr = SAMPLE_RATE;
  const f0 = midiToFreq(midi);
  const s0 = Math.floor(start * sr);
  const n = Math.floor(dur * sr);
  const phase = rng() * Math.PI * 2;
  for (let h = 1; h <= 4; h++) {
    const amp = (vel * Math.pow(brightness, h - 1)) / h;
    if (amp < 0.005) continue;
    const f = f0 * h;
    if (f > sr * 0.45) break;
    const w = (2 * Math.PI * f) / sr;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.exp(-2.5 * t / dur) * Math.min(1, t * 80);
      const idx = s0 + i;
      if (idx >= 0 && idx < out.length) out[idx] += amp * env * Math.sin(w * i + phase * h);
    }
  }
}

function addKick(out, start, vel) {
  const sr = SAMPLE_RATE;
  const s0 = Math.floor(start * sr);
  const n = Math.floor(0.12 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 120 * Math.exp(-30 * t) + 45;
    const idx = s0 + i;
    if (idx < out.length) out[idx] += vel * Math.exp(-25 * t) * Math.sin(2 * Math.PI * f * t);
  }
}

function addHat(out, start, vel, rng) {
  const sr = SAMPLE_RATE;
  const s0 = Math.floor(start * sr);
  const n = Math.floor(0.04 * sr);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const white = rng() * 2 - 1;
    lp += 0.35 * (white - lp);
    const idx = s0 + i;
    if (idx < out.length) out[idx] += vel * Math.exp(-60 * t) * (white - lp);
  }
}

// Compose a deterministic song: chord pads, melody, bass, drums.
// The seed picks key, tempo, progression, rhythm and drum pattern, so
// different seeds produce genuinely unrelated songs.
const CHORD_POOL = [45, 48, 50, 52, 53, 55, 57, 59, 60]; // diatonic roots

export function generateSong(seed, seconds = 40) {
  const rng = makeRng(seed);
  const sr = SAMPLE_RATE;
  const out = new Float32Array(Math.floor(seconds * sr));
  const key = Math.floor(rng() * 7) - 3;
  const bpm = 80 + Math.floor(rng() * 55);
  const beat = 60 / bpm;
  const bar = beat * 4;
  const brightness = 0.45 + rng() * 0.35;
  const penta = [0, 2, 4, 7, 9];
  // per-song 8-chord progression (two phrases) to reduce loop self-similarity
  const roots = [];
  for (let i = 0; i < 8; i++) roots.push(CHORD_POOL[Math.floor(rng() * CHORD_POOL.length)] + key);
  // per-song melody rhythm: subdivision and rest probability
  const subdiv = rng() < 0.5 ? 2 : 4;
  const restProb = 0.15 + rng() * 0.3;
  // per-song drum pattern (16 steps: kick, hat)
  const kickPat = [], hatPat = [];
  for (let i = 0; i < 16; i++) {
    kickPat.push(i % 4 === 0 ? true : rng() < 0.15);
    hatPat.push(i % 2 === 1 ? true : rng() < 0.3);
  }
  const chordIv = rng() < 0.5 ? [0, 4, 7] : [0, 3, 7]; // major or minor

  const nBars = Math.floor(seconds / bar);
  let melodyMidi = 69 + key;
  for (let b = 0; b < nBars; b++) {
    const t0 = b * bar;
    const root = roots[b % roots.length];
    for (const iv of chordIv) addNote(out, t0, bar * 0.95, root + 12 + iv, 0.10, rng, brightness);
    for (let q = 0; q < 4; q++) addNote(out, t0 + q * beat, beat * 0.8, root - 12, 0.16, rng, 0.6);
    const steps = 4 * subdiv;
    for (let s = 0; s < steps; s++) {
      if (rng() < restProb) continue;
      melodyMidi += penta[Math.floor(rng() * penta.length)] - 4;
      melodyMidi = Math.max(64, Math.min(84, melodyMidi));
      addNote(out, t0 + (s * bar) / steps, (bar / steps) * 0.9, melodyMidi, 0.20, rng, brightness);
    }
    for (let s = 0; s < 16; s++) {
      const t = t0 + (s * bar) / 16;
      if (kickPat[s]) addKick(out, t, 0.5);
      if (hatPat[s]) addHat(out, t, 0.12, rng);
    }
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.8 / peak;
  return out;
}
