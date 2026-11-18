/* Deterministic synthetic "long recording" with known ground truth. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TestSignal = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SR = 16000;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // One-pole low-passed white noise -> colored background ambience.
  function makeNoise(rand, n, rms, cutoff) {
    const out = new Float32Array(n);
    const alpha = cutoff / (cutoff + SR * 0.5);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1;
      lp += alpha * (white - lp);
      out[i] = lp;
    }
    let energy = 0;
    for (let i = 0; i < n; i++) energy += out[i] * out[i];
    const scale = rms / (Math.sqrt(energy / n) + 1e-12);
    for (let i = 0; i < n; i++) out[i] *= scale;
    return out;
  }

  // Harmonic voiced excitation + unvoiced fricative => low-flatness,
  // speech-like spectrum with time-varying pitch and amplitude envelope.
  function makeSpeech(rand, n, rms, f0Start, f0End) {
    const out = new Float32Array(n);
    const phase = [0, 0, 0, 0, 0];
    const harmonics = [1, 2, 3, 4, 5];
    const gains = [1, 0.55, 0.32, 0.18, 0.1];
    let lpFric = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const prog = i / n;
      const f0 = f0Start + (f0End - f0Start) * prog + 6 * Math.sin(2 * Math.PI * 4.5 * t);
      let voiced = 0;
      for (let h = 0; h < harmonics.length; h++) {
        phase[h] += (2 * Math.PI * f0 * harmonics[h]) / SR;
        voiced += gains[h] * Math.sin(phase[h]);
      }
      // Syllable-like amplitude wobble (3-5 Hz).
      const envelope = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 3.8 * t), 1.5);
      const fricGate = Math.max(0, Math.sin(2 * Math.PI * 2.1 * t + 1.3)) > 0.82 ? 1 : 0;
      lpFric += 0.35 * ((rand() * 2 - 1) - lpFric);
      const unvoiced = fricGate * lpFric * 1.4;
      // Fade in/out per speech block to avoid edge clicks.
      const edge = Math.min(1, i / 400, (n - 1 - i) / 400);
      out[i] = edge * envelope * (0.85 * voiced + 0.3 * unvoiced);
    }
    let energy = 0;
    for (let i = 0; i < n; i++) energy += out[i] * out[i];
    const scale = rms / (Math.sqrt(energy / n) + 1e-12);
    for (let i = 0; i < n; i++) out[i] *= scale;
    return out;
  }

  // Broadband damped impulse: high energy for a few ms, flat spectrum and
  // high ZCR — must be rejected as speech onset by the VAD.
  function makeClick(rand, n, rms) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const decay = Math.exp(-i / (SR * 0.004));
      out[i] = (rand() * 2 - 1) * decay;
    }
    let energy = 0;
    for (let i = 0; i < n; i++) energy += out[i] * out[i];
    const scale = rms / (Math.sqrt(energy / n) + 1e-12);
    for (let i = 0; i < n; i++) out[i] *= scale;
    return out;
  }

  function generate() {
    const rand = mulberry32(20261118);
    // Timeline in seconds: [kind, start, end, params]
    const spec = [
      ["silence", 0.0, 1.0],
      ["speech", 1.0, 3.2, 0.09, 125, 168],
      ["silence", 3.2, 3.42], // 220ms gap -> merged
      ["speech", 3.42, 5.1, 0.085, 150, 118],
      ["silence", 5.1, 5.28], // 180ms gap -> merged
      ["speech", 5.28, 6.4, 0.08, 132, 158],
      ["click", 6.55], // lone keyboard click, must NOT start speech
      ["silence", 6.4, 7.2],
      ["noise", 7.2, 10.5, 0.028], // steady background noise section
      ["click", 7.6], ["click", 9.9], // clicks buried in noise section
      ["speech", 10.5, 12.6, 0.088, 140, 175],
      ["silence", 12.6, 13.6],
      ["speech", 13.6, 14.15, 0.05, 118, 140], // softer, short utterance
      ["silence", 14.15, 14.5],
      ["click", 14.32], // click inside silence
      ["noise", 14.5, 17.0, 0.02],
      ["speech", 17.0, 19.3, 0.082, 160, 125],
      ["click", 19.45],
      ["silence", 19.3, 20.0]
    ];
    const duration = 20.0;
    const samples = new Float32Array(Math.round(duration * SR));
    const groundTruth = [];
    const events = [];
    for (const item of spec) {
      const [kind, start, end] = item;
      const n = Math.round((end - start) * SR);
      const off = Math.round(start * SR);
      let block = null;
      if (kind === "speech") block = makeSpeech(rand, n, item[3], item[4], item[5]);
      else if (kind === "noise") block = makeNoise(rand, n, item[3], 1200);
      else if (kind === "silence") block = new Float32Array(n);
      else if (kind === "click") {
        const cn = Math.round(0.05 * SR);
        block = makeClick(rand, cn, 0.11);
        const cOff = Math.round(item[1] * SR);
        for (let i = 0; i < block.length && cOff + i < samples.length; i++) {
          samples[cOff + i] += block[i];
        }
        events.push({ type: "click", start: item[1], end: item[1] + 0.05 });
        continue;
      }
      // Accumulate so later blocks (e.g. silence) never overwrite clicks
      // that were already added at offsets inside their span.
      for (let i = 0; i < n && off + i < samples.length; i++) samples[off + i] += block[i];
      groundTruth.push({ start, end, label: kind });
    }
    // Fuse adjacent same-label ground-truth pieces into canonical intervals.
    const merged = [];
    for (const seg of groundTruth) {
      const prev = merged[merged.length - 1];
      if (prev && prev.label === seg.label && Math.abs(prev.end - seg.start) < 1e-6) {
        prev.end = seg.end;
      } else merged.push(Object.assign({}, seg));
    }
    return {
      sampleRate: SR,
      durationSec: duration,
      samples,
      groundTruth: merged,
      events,
      description: "20s deterministic fixture: 5 speech blocks, mergeable short pauses, 5 keyboard clicks, noise and silence"
    };
  }

  return { generate, SR };
});
