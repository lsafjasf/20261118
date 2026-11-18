/* Frame-level feature extraction: short-time energy, ZCR, spectral flatness. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./fft.js"));
  } else root.Features = factory(root.FFT);
})(typeof self !== "undefined" ? self : this, function (FFT) {
  "use strict";

  const DEFAULTS = {
    sampleRate: 16000,
    frameMs: 32, // 512 samples @16k -> power-of-two FFT
    hopMs: 10,
    floorDb: -80 // energy clamp so silence stays numerically stable
  };

  function hann(size) {
    const w = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return w;
  }

  // Geometric/arithmetic mean ratio on magnitude spectrum (0..1).
  // High (~1) for noise-like flat spectra; low for harmonic speech.
  function spectralFlatness(re, im) {
    const n = re.length;
    let logSum = 0;
    let arith = 0;
    let used = 0;
    const floor = 1e-8;
    for (let k = 1; k < n / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) + floor;
      logSum += Math.log(mag);
      arith += mag;
      used++;
    }
    arith /= used;
    const geo = Math.exp(logSum / used) - floor;
    if (geo <= 0 || arith <= 0) return 0;
    return Math.min(1, geo / arith);
  }

  function extract(samples, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const frameLen = Math.round((cfg.frameMs / 1000) * cfg.sampleRate);
    const hopLen = Math.round((cfg.hopMs / 1000) * cfg.sampleRate);
    const window = hann(frameLen);
    const fft = new FFT(frameLen);
    const re = new Float32Array(frameLen);
    const im = new Float32Array(frameLen);
    const frames = [];

    for (let start = 0; start + frameLen <= samples.length; start += hopLen) {
      let sumSq = 0;
      let crossings = 0;
      let prev = samples[start] - 0;
      for (let i = 0; i < frameLen; i++) {
        const x = samples[start + i];
        sumSq += x * x;
        const wx = x * window[i];
        re[i] = wx;
        im[i] = 0;
        if (i > 0 && (prev >= 0) !== (x >= 0)) crossings++;
        prev = x;
      }
      fft.run(re, im);
      const rms = Math.sqrt(sumSq / frameLen);
      const energyDb = Math.max(cfg.floorDb, 20 * Math.log10(rms + 1e-10));
      const zcr = crossings / (frameLen - 1);
      const flatness = spectralFlatness(re, im);
      frames.push({
        index: frames.length,
        startSample: start,
        endSample: start + frameLen,
        start: start / cfg.sampleRate,
        end: (start + frameLen) / cfg.sampleRate,
        energyDb,
        zcr,
        flatness
      });
    }
    return {
      frames,
      sampleRate: cfg.sampleRate,
      frameMs: cfg.frameMs,
      hopMs: cfg.hopMs,
      frameLen,
      hopLen
    };
  }

  return { extract, DEFAULTS };
});
