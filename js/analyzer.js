// Browser analyzer: runs K-weighting through an OfflineAudioContext
// (IIRFilterNode with BS.1770 coefficients), then computes metrics with
// the shared DSP core (js/dsp.js).
(function (global) {
  'use strict';

  // Channel weight policy (documented in README):
  //  1 ch  -> mono [1]
  //  2 ch  -> stereo [1, 1]
  //  3-6ch -> BS.1770 5.1 order L R C LFE Ls Rs, LFE excluded (weight 0),
  //           surrounds weighted 1.41 (~+1.5 dB)
  //  >6 ch -> first 6 channels used, a warning is recorded
  function channelWeightsFor(numChannels, warnings) {
    switch (numChannels) {
      case 1: return [1];
      case 2: return [1, 1];
      case 3: return [1, 1, 1];
      case 4: return [1, 1, 1, 0];
      case 5: return [1, 1, 1, 0, 1.41];
      case 6: return [1, 1, 1, 0, 1.41, 1.41];
      default:
        warnings.push('声道数 ' + numChannels + ' 超过 6，仅分析前 6 声道（5.1 布局）。');
        return [1, 1, 1, 0, 1.41, 1.41];
    }
  }

  // K-weight the buffer through an OfflineAudioContext and return
  // Float64Array channel data plus the rendered buffer.
  async function kWeightViaOfflineContext(buffer, weights) {
    var sr = buffer.sampleRate;
    var channels = Math.min(buffer.numberOfChannels, weights.length);
    var ctx = new OfflineAudioContext(channels, buffer.length, sr);
    var coeffs = DSP.kWeightingCoeffs(sr);
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    var stage1 = new IIRFilterNode(ctx, { feedforward: coeffs.stage1.b, feedback: coeffs.stage1.a });
    var stage2 = new IIRFilterNode(ctx, { feedforward: coeffs.stage2.b, feedback: coeffs.stage2.a });
    src.connect(stage1).connect(stage2).connect(ctx.destination);
    src.start();
    var rendered = await ctx.startRendering();
    var out = [];
    for (var ch = 0; ch < channels; ch++) {
      var f32 = rendered.getChannelData(ch);
      var f64 = new Float64Array(f32.length);
      for (var i = 0; i < f32.length; i++) f64[i] = f32[i];
      out.push(f64);
    }
    return out;
  }

  function rawChannelData(buffer, count) {
    var out = [];
    for (var ch = 0; ch < count; ch++) {
      var f32 = buffer.getChannelData(ch);
      var f64 = new Float64Array(f32.length);
      for (var i = 0; i < f32.length; i++) f64[i] = f32[i];
      out.push(f64);
    }
    return out;
  }

  // Full analysis pass. Returns everything the UI and the JSON export need.
  async function analyzeBuffer(buffer, label) {
    var warnings = [];
    var weights = channelWeightsFor(buffer.numberOfChannels, warnings);
    var sr = buffer.sampleRate;
    var raw = rawChannelData(buffer, weights.length);
    var weighted = await kWeightViaOfflineContext(buffer, weights);

    var integrated = DSP.integratedLoudness(weighted, sr, weights);
    var tp = DSP.truePeak(raw, sr);
    var clips = DSP.findClipCandidates(raw, sr);
    var samplePeak = 0;
    for (var ch = 0; ch < raw.length; ch++) {
      for (var i = 0; i < raw[ch].length; i++) {
        var a = Math.abs(raw[ch][i]);
        if (a > samplePeak) samplePeak = a;
      }
    }

    return {
      label: label,
      sampleRate: sr,
      channels: buffer.numberOfChannels,
      analyzedChannels: weights.length,
      durationSec: buffer.duration,
      channelWeights: weights,
      warnings: warnings,
      integratedLUFS: integrated.integrated,
      gatedBlockCount: integrated.gatedBlockCount,
      blockCount: integrated.blockCount,
      truePeak: tp,
      samplePeakLinear: samplePeak,
      samplePeakDbFS: samplePeak > 0 ? 20 * Math.log10(samplePeak) : -Infinity,
      clipSpans: clips,
      // kept for curve recomputation when the user switches windows
      _weighted: weighted,
      _weights: weights
    };
  }

  // Recompute the sliding-window curve for the currently selected window.
  function curveForWindow(result, windowSec) {
    return DSP.slidingLoudness(result._weighted, result.sampleRate, windowSec, windowSec / 4, result._weights);
  }

  // Render a gained copy through an OfflineAudioContext. The caller exports
  // it as a NEW file; the original is never modified.
  async function renderGainedCopy(buffer, gainDb) {
    var ctx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    var gain = ctx.createGain();
    gain.gain.value = Math.pow(10, gainDb / 20);
    src.connect(gain).connect(ctx.destination);
    src.start();
    return ctx.startRendering();
  }

  global.Analyzer = {
    analyzeBuffer: analyzeBuffer,
    curveForWindow: curveForWindow,
    renderGainedCopy: renderGainedCopy,
    channelWeightsFor: channelWeightsFor
  };
})(typeof self !== 'undefined' ? self : this);
