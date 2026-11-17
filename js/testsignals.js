// Synthetic test signals, shared by the browser UI and the Node test run.
// Each returns { sampleRate, channels: [Float64Array, ...], label }.
(function (global) {
  'use strict';

  // 1 kHz sine at -20 dBFS, stereo, with a 1 s pure-silence gap in the
  // middle to verify silence is gated out and never yields extreme gain.
  function sineWithSilence(sr, durationSec) {
    sr = sr || 48000;
    durationSec = durationSec || 6;
    var n = Math.round(sr * durationSec);
    var amp = Math.pow(10, -20 / 20);
    var gapStart = Math.round(sr * 2.5), gapEnd = Math.round(sr * 3.5);
    var L = new Float64Array(n), R = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      if (i >= gapStart && i < gapEnd) continue;
      var v = amp * Math.sin(2 * Math.PI * 1000 * i / sr);
      L[i] = v; R[i] = v;
    }
    return { sampleRate: sr, channels: [L, R], label: 'sine-1kHz--20dBFS-with-1s-silence' };
  }

  // Sparse instantaneous impulses: full-scale single-sample clicks plus one
  // clipped plateau, to exercise true-peak and clip detection.
  function impulses(sr, durationSec) {
    sr = sr || 48000;
    durationSec = durationSec || 4;
    var n = Math.round(sr * durationSec);
    var L = new Float64Array(n), R = new Float64Array(n);
    var clickTimes = [0.5, 1.0, 1.5, 2.0, 2.5];
    for (var c = 0; c < clickTimes.length; c++) {
      var idx = Math.round(clickTimes[c] * sr);
      L[idx] = c % 2 === 0 ? 1.0 : -1.0;
      R[idx] = c % 2 === 0 ? -1.0 : 1.0;
    }
    // clipped plateau at 3 s: 8 consecutive samples at full scale
    var p = Math.round(3.0 * sr);
    for (var k = 0; k < 8; k++) { L[p + k] = 1.0; R[p + k] = 1.0; }
    return { sampleRate: sr, channels: [L, R], label: 'impulses-fullscale-plus-clip' };
  }

  // Left/right asymmetric: left sine at -14 dBFS, right at -26 dBFS with
  // different frequency, plus a right-only clipped burst.
  function asymmetric(sr, durationSec) {
    sr = sr || 48000;
    durationSec = durationSec || 5;
    var n = Math.round(sr * durationSec);
    var ampL = Math.pow(10, -14 / 20), ampR = Math.pow(10, -26 / 20);
    var L = new Float64Array(n), R = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      L[i] = ampL * Math.sin(2 * Math.PI * 440 * i / sr);
      R[i] = ampR * Math.sin(2 * Math.PI * 1560 * i / sr);
    }
    var p = Math.round(4.0 * sr);
    for (var k = 0; k < 4; k++) R[p + k] = 1.0; // right-only clip burst
    return { sampleRate: sr, channels: [L, R], label: 'asymmetric-L-minus14dB-R-minus26dB' };
  }

  var TestSignals = {
    sineWithSilence: sineWithSilence,
    impulses: impulses,
    asymmetric: asymmetric
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = TestSignals;
  else global.TestSignals = TestSignals;
})(typeof self !== 'undefined' ? self : this);
