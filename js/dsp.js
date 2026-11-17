// Pure DSP core shared by the browser analyzer (js/analyzer.js) and the
// Node test harness (tests/run-tests.mjs). No DOM / Web Audio dependencies.
(function (global) {
  'use strict';

  var ABS_GATE_LUFS = -70.0;   // BS.1770 absolute gate
  var REL_GATE_LU = 10.0;      // BS.1770 relative gate
  var LOUDNESS_OFFSET = -0.691; // BS.1770 calibration offset
  var MAX_SUGGESTED_GAIN_DB = 60.0; // sanity clamp for near-silence

  // Published ITU-R BS.1770 K-weighting coefficients (48 kHz reference).
  var K48_STAGE1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
                     a: [1, -1.69065929318241, 0.73248077421585] };
  var K48_STAGE2 = { b: [1, -2, 1],
                     a: [1, -1.99004745483398, 0.99007225036621] };

  // --- minimal complex arithmetic for pole/zero remapping ---
  function cx(re, im) { return { re: re, im: im || 0 }; }
  function cadd(a, b) { return cx(a.re + b.re, a.im + b.im); }
  function csub(a, b) { return cx(a.re - b.re, a.im - b.im); }
  function cmul(a, b) { return cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re); }
  function cdiv(a, b) {
    var d = b.re * b.re + b.im * b.im;
    return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
  }
  function cneg(a) { return cx(-a.re, -a.im); }
  function csqrt(z) {
    var m = Math.hypot(z.re, z.im);
    return cx(Math.sqrt((m + z.re) / 2), (z.im < 0 ? -1 : 1) * Math.sqrt((m - z.re) / 2));
  }
  function quadRoots(c2, c1, c0) {
    var disc = csub(cmul(c1, c1), cmul(cx(4), cmul(c2, c0)));
    var sq = csqrt(disc);
    var two = cmul(cx(2), c2);
    return [cdiv(cadd(cneg(c1), sq), two), cdiv(csub(cneg(c1), sq), two)];
  }

  // Remap a biquad from 48 kHz to an arbitrary sample rate by pulling its
  // poles/zeros back to the analog domain (inverse bilinear) and
  // re-discretizing, preserving the gain at z = -1.
  function remapBiquad48(b, a, sampleRate) {
    if (sampleRate === 48000) return { b: b.slice(), a: a.slice() };
    var T1 = 1 / 48000, T2 = 1 / sampleRate;
    var zb = quadRoots(cx(b[0]), cx(b[1]), cx(b[2]));
    var za = quadRoots(cx(a[0]), cx(a[1]), cx(a[2]));
    function z2s(z) { return cdiv(cmul(cx(2 / T1), csub(z, cx(1))), cadd(z, cx(1))); }
    function s2z(s) { return cdiv(cadd(cx(1), cmul(s, cx(T2 / 2))), csub(cx(1), cmul(s, cx(T2 / 2)))); }
    function monic(r) {
      var s = cadd(r[0], r[1]), p = cmul(r[0], r[1]);
      return [cx(1), cneg(s), p];
    }
    var bn = monic(zb.map(function (z) { return s2z(z2s(z)); }));
    var an = monic(za.map(function (z) { return s2z(z2s(z)); }));
    function evalPoly(co, z) {
      return cadd(cadd(cmul(cx(co[0]), cmul(z, z)), cmul(cx(co[1]), z)), cx(co[2]));
    }
    var bnR = bn.map(function (x) { return x.re; });
    var anR = an.map(function (x) { return x.re; });
    var H48 = cdiv(evalPoly(b, cx(-1)), evalPoly(a, cx(-1)));
    var Hn = cdiv(evalPoly(bnR, cx(-1)), evalPoly(anR, cx(-1)));
    var K = cdiv(H48, Hn).re;
    return { b: bnR.map(function (x) { return x * K; }), a: anR };
  }

  // K-weighting coefficients for any sample rate (exact at 48 kHz).
  function kWeightingCoeffs(sampleRate) {
    return {
      stage1: remapBiquad48(K48_STAGE1.b, K48_STAGE1.a, sampleRate),
      stage2: remapBiquad48(K48_STAGE2.b, K48_STAGE2.a, sampleRate)
    };
  }

  // Direct-form II transposed biquad.
  function biquadFilter(input, coeffs) {
    var b = coeffs.b, a = coeffs.a;
    var out = new Float64Array(input.length);
    var z1 = 0, z2 = 0;
    for (var i = 0; i < input.length; i++) {
      var x = input[i];
      var y = b[0] * x + z1;
      z1 = b[1] * x - a[1] * y + z2;
      z2 = b[2] * x - a[2] * y;
      out[i] = y;
    }
    return out;
  }

  function kWeight(input, sampleRate) {
    var c = kWeightingCoeffs(sampleRate);
    return biquadFilter(biquadFilter(input, c.stage1), c.stage2);
  }

  // Mean-square of each channel over [start, end) -> loudness in LUFS.
  function blockLoudnessLUFS(channelData, start, end, channelWeights) {
    var sum = 0;
    for (var ch = 0; ch < channelData.length; ch++) {
      var w = channelWeights ? channelWeights[ch] : 1.0;
      if (w === 0) continue;
      var data = channelData[ch];
      var ms = 0;
      for (var i = start; i < end; i++) ms += data[i] * data[i];
      ms /= (end - start);
      sum += w * ms;
    }
    if (sum <= 0) return -Infinity;
    return LOUDNESS_OFFSET + 10 * Math.log10(sum);
  }

  // Sliding-window loudness curve (momentary 400 ms / short-term 3 s / custom).
  // Hop defaults to window/4 (BS.1770 uses 75% overlap for 400 ms blocks).
  function slidingLoudness(channelData, sampleRate, windowSec, hopSec, channelWeights) {
    var n = channelData[0].length;
    var win = Math.max(1, Math.round(windowSec * sampleRate));
    var hop = Math.max(1, Math.round((hopSec || windowSec / 4) * sampleRate));
    var times = [];
    var values = [];
    for (var start = 0; start + win <= n; start += hop) {
      times.push((start + win / 2) / sampleRate);
      values.push(blockLoudnessLUFS(channelData, start, start + win, channelWeights));
    }
    return { times: times, values: values, windowSec: windowSec, hopSec: hop };
  }

  // BS.1770 integrated loudness: 400 ms blocks, 75% overlap,
  // absolute gate at -70 LUFS then relative gate at (ungated mean - 10 LU).
  function integratedLoudness(channelData, sampleRate, channelWeights) {
    var curve = slidingLoudness(channelData, sampleRate, 0.4, 0.1, channelWeights);
    var gated = [];
    for (var i = 0; i < curve.values.length; i++) {
      if (curve.values[i] > ABS_GATE_LUFS) gated.push(i);
    }
    if (gated.length === 0) {
      return { integrated: -Infinity, blockCount: curve.values.length, gatedBlockCount: 0 };
    }
    var win = Math.round(0.4 * sampleRate);
    function blockEnergy(idx) {
      var start = Math.round((curve.times[idx] - 0.2) * sampleRate);
      var e = 0;
      for (var ch = 0; ch < channelData.length; ch++) {
        var w = channelWeights ? channelWeights[ch] : 1.0;
        if (w === 0) continue;
        var data = channelData[ch];
        var ms = 0;
        for (var j = start; j < start + win; j++) ms += data[j] * data[j];
        e += w * ms / win;
      }
      return e;
    }
    function meanEnergy(indices) {
      var sum = 0;
      for (var k = 0; k < indices.length; k++) sum += blockEnergy(indices[k]);
      return sum / indices.length;
    }
    var relGate = LOUDNESS_OFFSET + 10 * Math.log10(meanEnergy(gated)) - REL_GATE_LU;
    var finalIdx = [];
    for (var m = 0; m < gated.length; m++) {
      if (curve.values[gated[m]] > relGate) finalIdx.push(gated[m]);
    }
    if (finalIdx.length === 0) {
      return { integrated: -Infinity, blockCount: curve.values.length, gatedBlockCount: 0 };
    }
    return {
      integrated: LOUDNESS_OFFSET + 10 * Math.log10(meanEnergy(finalIdx)),
      blockCount: curve.values.length,
      gatedBlockCount: finalIdx.length
    };
  }

  // True peak via 4x polyphase oversampling with a windowed-sinc FIR
  // (BS.1770 style). Returns per-channel peak in dBTP and the linear peak.
  function truePeak(channelData, sampleRate) {
    var OS = 4;
    var PER_PHASE = 32;
    // Odd total length puts a tap exactly at the filter center so that
    // sample-aligned peaks interpolate exactly (sinc zero crossings land
    // on the other taps of the center branch).
    var L = OS * PER_PHASE + 1;
    var center = (L - 1) / 2;
    // Build windowed-sinc low-pass at fc = 0.5/OS (normalized to OS rate).
    var h = [];
    for (var i = 0; i < L; i++) {
      var x = i - center;
      var sinc = x === 0 ? 1 / OS : Math.sin(Math.PI * x / OS) / (Math.PI * x);
      // Blackman window: lower passband ripple than Hann for peak accuracy.
      var win = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)) +
                0.08 * Math.cos(4 * Math.PI * i / (L - 1));
      h.push(sinc * win);
    }
    // Interpolation filter: normalize each polyphase branch to sum to 1 so
    // DC gain is exactly 1 at every fractional offset (flat passband).
    for (var ph2 = 0; ph2 < OS; ph2++) {
      var branchSum = 0;
      for (var j2 = ph2; j2 < L; j2 += OS) branchSum += h[j2];
      for (var j3 = ph2; j3 < L; j3 += OS) h[j3] /= branchSum;
    }

    var result = [];
    for (var ch = 0; ch < channelData.length; ch++) {
      var data = channelData[ch];
      var peak = 0;
      var peakIndex = 0;
      for (var n = 0; n < data.length; n++) {
        for (var ph = 0; ph < OS; ph++) {
          var acc = 0;
          for (var t = 0; ph + t * OS < L; t++) {
            var idx = n - t;
            // Constant extrapolation at the edges avoids boundary overshoot
            // being misread as a true-peak overload.
            if (idx < 0) idx = 0;
            else if (idx >= data.length) idx = data.length - 1;
            acc += h[ph + t * OS] * data[idx];
          }
          var a = Math.abs(acc);
          if (a > peak) { peak = a; peakIndex = n; }
        }
      }
      result.push({
        linear: peak,
        dBTP: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
        sampleIndex: peakIndex,
        timeSec: peakIndex / sampleRate
      });
    }
    return result;
  }

  // Clipping candidates: samples whose absolute value reaches the threshold
  // (default -0.01 dBFS ~= 0.9989). Consecutive overloads merge into one span.
  function findClipCandidates(channelData, sampleRate, threshold) {
    var th = threshold || 0.9989;
    var spans = [];
    for (var ch = 0; ch < channelData.length; ch++) {
      var data = channelData[ch];
      var runStart = -1;
      for (var i = 0; i <= data.length; i++) {
        var over = i < data.length && Math.abs(data[i]) >= th;
        if (over && runStart < 0) runStart = i;
        if (!over && runStart >= 0) {
          spans.push({
            channel: ch,
            startSec: runStart / sampleRate,
            endSec: i / sampleRate,
            lengthSamples: i - runStart
          });
          runStart = -1;
        }
      }
    }
    spans.sort(function (a, b) { return a.startSec - b.startSec; });
    return spans;
  }

  // Gain needed to hit the target loudness. Silence (integrated = -Inf) must
  // NOT produce a huge number: report it as not applicable instead.
  function gainToTarget(integratedLUFS, targetLUFS) {
    if (!isFinite(integratedLUFS)) {
      return { applicable: false, gainDb: null, reason: 'silence' };
    }
    var gain = targetLUFS - integratedLUFS;
    var clamped = Math.max(-MAX_SUGGESTED_GAIN_DB, Math.min(MAX_SUGGESTED_GAIN_DB, gain));
    return {
      applicable: true,
      gainDb: clamped,
      clamped: clamped !== gain,
      reason: clamped !== gain ? 'clamped' : 'ok'
    };
  }

  var DSP = {
    ABS_GATE_LUFS: ABS_GATE_LUFS,
    REL_GATE_LU: REL_GATE_LU,
    LOUDNESS_OFFSET: LOUDNESS_OFFSET,
    MAX_SUGGESTED_GAIN_DB: MAX_SUGGESTED_GAIN_DB,
    kWeightingCoeffs: kWeightingCoeffs,
    biquadFilter: biquadFilter,
    kWeight: kWeight,
    blockLoudnessLUFS: blockLoudnessLUFS,
    slidingLoudness: slidingLoudness,
    integratedLoudness: integratedLoudness,
    truePeak: truePeak,
    findClipCandidates: findClipCandidates,
    gainToTarget: gainToTarget
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;
  else global.DSP = DSP;
})(typeof self !== 'undefined' ? self : this);
