/*
 * Browser/Node shared DSP library, matching src/analyze_audio.py exactly:
 *   - ITU-R BS.1770-4 K-weighting (high shelf + high-pass), applied once over
 *     the whole decoded signal (filter state never reset at window edges);
 *   - Hann analysis frame with 50% hop (COLA);
 *   - ungated K-weighted loudness LUFS = -0.691 + 10*log10(mean square);
 *   - sample-accurate unweighted peak and RMS-based silence per hop cell.
 * All timestamps use the absolute global time axis (sample index / sampleRate),
 * so re-analyzing a dragged window never renumbers time.
 */
(function (global) {
  'use strict';

  function rbj(sampleRate, f0, gainDb, q) {
    const amp = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * f0) / sampleRate;
    const cosW = Math.cos(w0), sinW = Math.sin(w0);
    const alpha = (sinW / 2) * Math.sqrt(
      (amp + 1 / amp) * (1 / q - 1) + 2
    );
    const sa = 2 * Math.sqrt(amp) * alpha;
    const b0 = amp * ((amp + 1) + (amp - 1) * cosW + sa);
    const b1 = -2 * amp * ((amp - 1) + (amp + 1) * cosW);
    const b2 = amp * ((amp + 1) + (amp - 1) * cosW - sa);
    const a0 = (amp + 1) - (amp - 1) * cosW + sa;
    const a1 = 2 * ((amp - 1) - (amp + 1) * cosW);
    const a2 = (amp + 1) - (amp - 1) * cosW - sa;
    return { b: [b0 / a0, b1 / a0, b2 / a0], a: [1, a1 / a0, a2 / a0] };
  }

  // Direct-form II transposed biquad; equivalent to scipy.signal.lfilter.
  function lfilter(b, a, x) {
    const y = new Float64Array(x.length);
    let z1 = 0, z2 = 0;
    const [b0, b1, b2] = b;
    const [, a1, a2] = a;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = b0 * xi + z1;
      z1 = b1 * xi - a1 * yi + z2;
      z2 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
    return y;
  }

  function kWeight(x, sampleRate) {
    const shelf = rbj(sampleRate, 1681.763225115885, 4.0, 0.7071752369554193);
    const hp = rbj(sampleRate, 38.13547087602444, 0.0, 0.5003270373238773);
    let y = lfilter(shelf.b, shelf.a, x);
    y = lfilter(hp.b, hp.a, y);
    return y;
  }

  function analyze(samples, sampleRate, opts) {
    const options = opts || {};
    const windowS = options.windowS || 1.0;
    const hopS = options.hopS || 0.5;
    const silenceDbfs = options.silenceDbfs != null ? options.silenceDbfs : -60;
    // Global sample offset of `samples` within the full track. Local windows
    // pass an explicit offset so output time stays on the global axis.
    const globalOffset = options.globalOffsetSamples || 0;

    const win = Math.round(windowS * sampleRate);
    const hop = Math.round(hopS * sampleRate);
    const hann = new Float64Array(win);
    let wNorm = 0;
    for (let n = 0; n < win; n++) {
      hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / win);
      wNorm += hann[n];
    }

    // Weight the provided samples once; because filters are zero-state and the
    // viewer re-analyzes from a fixed absolute start, we weight the whole
    // decoded track once at load and pass the weighted tail in via options.
    const weighted = options.weighted || kWeight(samples, sampleRate);
    const silencePower = Math.pow(10, silenceDbfs / 10);

    const tS = [], loudness = [], peakDbfs = [], peakTimeS = [],
      silenceRatio = [], cellRmsDbfs = [];
    const limit = samples.length - win;
    for (let fs = 0; fs <= limit; fs += hop) {
      let acc = 0;
      for (let n = 0; n < win; n++) {
        const wv = weighted[fs + n];
        acc += hann[n] * wv * wv;
      }
      const meanSq = acc / wNorm;
      const lufs = meanSq > 1e-12 ? -0.691 + 10 * Math.log10(meanSq) : -120.691;

      const c1 = Math.min(fs + hop, samples.length);
      let peak = 0, peakOff = 0, cellSq = 0;
      for (let n = fs; n < c1; n++) {
        const av = Math.abs(samples[n]);
        if (av > peak) { peak = av; peakOff = n - fs; }
        cellSq += samples[n] * samples[n];
      }
      const cellMeanSq = cellSq / (c1 - fs);
      const silent = cellMeanSq < silencePower ? 1 : 0;

      const globalStartSample = globalOffset + fs;
      tS.push(globalStartSample / sampleRate);
      loudness.push(lufs);
      peakDbfs.push(20 * Math.log10(Math.max(peak, 1e-12)));
      peakTimeS.push((globalOffset + fs + peakOff) / sampleRate);
      silenceRatio.push(silent);
      cellRmsDbfs.push(cellMeanSq > 1e-12 ? 10 * Math.log10(cellMeanSq) / 2 : -120);
    }

    return {
      sampleRate, windowS, hopS, silenceDbfs,
      globalOffsetSamples: globalOffset,
      timeline: { tS, loudness, peakDbfs, peakTimeS, silenceRatio, cellRmsDbfs },
    };
  }

  const api = { rbj, lfilter, kWeight, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.AudioMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
