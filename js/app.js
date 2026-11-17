// UI wiring: file loading, synthetic test signals, window selection,
// canvas plots, gain suggestion and exports. Never modifies the source
// file: gained output is always downloaded as a new file.
(function () {
  'use strict';

  var state = {
    buffer: null,      // decoded AudioBuffer (source, untouched)
    result: null,      // analysis result from Analyzer.analyzeBuffer
    windowSec: 0.4,    // currently selected analysis window
    label: ''
  };

  var $ = function (id) { return document.getElementById(id); };

  function fmtDb(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '-∞ ' + (unit || '');
    return (v > 0 ? '+' : '') + v.toFixed(2) + ' ' + (unit || '');
  }

  function setStatus(msg) { $('status').textContent = msg; }

  async function runAnalysis(buffer, label) {
    setStatus('分析中…');
    state.buffer = buffer;
    state.label = label;
    state.result = await Analyzer.analyzeBuffer(buffer, label);
    updateView();
    setStatus('分析完成：' + label);
  }

  function signalToBuffer(sig) {
    var ctx = new OfflineAudioContext(sig.channels.length, sig.channels[0].length, sig.sampleRate);
    var buf = ctx.createBuffer(sig.channels.length, sig.channels[0].length, sig.sampleRate);
    for (var ch = 0; ch < sig.channels.length; ch++) {
      buf.copyToChannel(new Float32Array(sig.channels[ch]), ch);
    }
    return buf;
  }

  async function handleFile(file) {
    var arrayBuffer = await file.arrayBuffer();
    // decodeAudioData resamples to the decoding context's rate; we read the
    // resulting buffer.sampleRate and run the whole analysis at that rate.
    var actx = new (window.AudioContext || window.webkitAudioContext)();
    var decoded = await actx.decodeAudioData(arrayBuffer);
    actx.close();
    await runAnalysis(decoded, file.name);
  }

  function bindInputs() {
    $('file-input').addEventListener('change', function (e) {
      if (e.target.files[0]) handleFile(e.target.files[0]).catch(function (err) {
        setStatus('解码失败：' + err.message);
      });
    });
    $('gen-sine').addEventListener('click', function () {
      runAnalysis(signalToBuffer(TestSignals.sineWithSilence()), '合成：1kHz 正弦（含 1s 静音）');
    });
    $('gen-impulse').addEventListener('click', function () {
      runAnalysis(signalToBuffer(TestSignals.impulses()), '合成：瞬时脉冲 + 削波平台');
    });
    $('gen-asym').addEventListener('click', function () {
      runAnalysis(signalToBuffer(TestSignals.asymmetric()), '合成：左右不对称');
    });
    $('window-select').addEventListener('change', function (e) {
      state.windowSec = parseFloat(e.target.value);
      if (state.result) updateView();
    });
    $('target-lufs').addEventListener('change', function () {
      if (state.result) updateView();
    });
    $('export-json').addEventListener('click', exportJson);
    $('export-gained').addEventListener('click', exportGainedCopy);
  }

  function targetLoudness() {
    var v = parseFloat($('target-lufs').value);
    return isFinite(v) ? v : -16;
  }

  // Refresh every number and curve from state.result + state.windowSec.
  function updateView() {
    var r = state.result;
    var curve = Analyzer.curveForWindow(r, state.windowSec);
    var finite = curve.values.filter(isFinite);
    var maxWin = finite.length ? Math.max.apply(null, finite) : -Infinity;

    $('m-integrated').textContent = fmtDb(r.integratedLUFS, 'LUFS');
    $('m-window-max').textContent = fmtDb(maxWin, 'LUFS');
    $('m-window-label').textContent = '窗口峰值（' + windowLabel() + '）';
    $('m-sample-peak').textContent = fmtDb(r.samplePeakDbFS, 'dBFS');
    var tpTexts = r.truePeak.map(function (p, i) {
      return 'Ch' + (i + 1) + ' ' + fmtDb(p.dBTP, 'dBTP');
    });
    $('m-true-peak').textContent = tpTexts.join('  |  ');
    $('m-clips').textContent = r.clipSpans.length > 0
      ? r.clipSpans.length + ' 处削波候选（见下图红色标记）'
      : '无削波候选';

    var meta = r.label + ' | ' + r.sampleRate + ' Hz | ' + r.channels + ' 声道' +
      (r.analyzedChannels !== r.channels ? '（分析前 ' + r.analyzedChannels + ' 声道）' : '') +
      ' | ' + r.durationSec.toFixed(2) + ' s';
    $('m-meta').textContent = meta;
    $('m-warnings').textContent = r.warnings.join(' ');

    updateGainPanel();
    drawCurve(curve);
    drawClipMap();
  }

  function windowLabel() {
    if (state.windowSec === 0.4) return '瞬时 400ms';
    if (state.windowSec === 3) return '短时 3s';
    return state.windowSec + 's';
  }

  // Gain suggestion with silence protection: -Inf integrated loudness must
  // not turn into a huge boost, and finite gains are clamped to +/-60 dB.
  function updateGainPanel() {
    var r = state.result;
    var target = targetLoudness();
    var g = DSP.gainToTarget(r.integratedLUFS, target);
    var el = $('m-gain');
    var btn = $('export-gained');
    if (!g.applicable) {
      el.textContent = '不适用（信号为静音或低于 -70 LUFS 绝对门限，不会给出增益）';
      el.className = 'gain-na';
      btn.disabled = true;
      return;
    }
    var note = g.clamped ? '（已限制在 ±' + DSP.MAX_SUGGESTED_GAIN_DB + ' dB，原始需求超出安全范围）' : '';
    el.textContent = fmtDb(g.gainDb, 'dB') + ' 可达到 ' + target + ' LUFS ' + note;
    el.className = g.clamped ? 'gain-warn' : 'gain-ok';
    btn.disabled = false;
  }

  // ---- plotting -----------------------------------------------------------

  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function drawCurve(curve) {
    var c = setupCanvas($('curve-canvas'));
    var ctx = c.ctx;
    ctx.clearRect(0, 0, c.w, c.h);
    var lo = -60, hi = 0; // fixed LUFS range keeps window switches comparable
    function y(v) { return c.h - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * c.h; }
    ctx.strokeStyle = '#2a2f3a';
    ctx.fillStyle = '#8a93a6';
    ctx.font = '10px sans-serif';
    for (var g = lo; g <= hi; g += 10) {
      ctx.beginPath(); ctx.moveTo(0, y(g)); ctx.lineTo(c.w, y(g)); ctx.stroke();
      ctx.fillText(g + ' LUFS', 4, y(g) - 2);
    }
    // target line
    var t = targetLoudness();
    ctx.strokeStyle = '#c9a227';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, y(t)); ctx.lineTo(c.w, y(t)); ctx.stroke();
    ctx.setLineDash([]);
    var dur = state.result.durationSec;
    ctx.strokeStyle = '#3fa7ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < curve.times.length; i++) {
      var v = curve.values[i];
      if (!isFinite(v)) { started = false; continue; } // silence gap in curve
      var x = curve.times[i] / dur * c.w;
      if (!started) { ctx.moveTo(x, y(v)); started = true; }
      else ctx.lineTo(x, y(v));
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  function drawClipMap() {
    var c = setupCanvas($('map-canvas'));
    var ctx = c.ctx;
    ctx.clearRect(0, 0, c.w, c.h);
    var r = state.result;
    var dur = r.durationSec;
    var buf = state.buffer; // waveform drawn from the original buffer
    var nCh = buf.numberOfChannels;
    var laneH = c.h / nCh;
    for (var ch = 0; ch < nCh; ch++) {
      var data = buf.getChannelData(ch);
      var mid = laneH * ch + laneH / 2;
      ctx.strokeStyle = '#23406b';
      ctx.beginPath();
      ctx.moveTo(0, mid); ctx.lineTo(c.w, mid); ctx.stroke();
      ctx.strokeStyle = '#5b8dd9';
      ctx.beginPath();
      var step = Math.max(1, Math.floor(data.length / c.w));
      for (var x = 0; x < c.w; x++) {
        var s0 = Math.floor(x * data.length / c.w);
        var min = 1, max = -1;
        for (var i = s0; i < Math.min(s0 + step, data.length); i++) {
          var v = data[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        ctx.moveTo(x + 0.5, mid - max * laneH * 0.45);
        ctx.lineTo(x + 0.5, mid - min * laneH * 0.45);
      }
      ctx.stroke();
    }
    // clip candidates as red markers on the map
    ctx.fillStyle = '#ff4444';
    for (var k = 0; k < r.clipSpans.length; k++) {
      var span = r.clipSpans[k];
      var cx = (span.startSec + span.endSec) / 2 / dur * c.w;
      var cy = laneH * span.channel + laneH / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(cx - 1, cy - 8, 2, 16);
    }
  }

  // ---- exports ------------------------------------------------------------

  function download(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function baseName(label) {
    return label.replace(/\.[^.]+$/, '').replace(/[^\w\-\u4e00-\u9fff]+/g, '_');
  }

  function exportJson() {
    if (!state.result) { setStatus('请先分析一段音频。'); return; }
    var r = state.result;
    var target = targetLoudness();
    var g = DSP.gainToTarget(r.integratedLUFS, target);
    var curve = Analyzer.curveForWindow(r, state.windowSec);
    var payload = {
      tool: 'offline-loudness-analyzer',
      standard: 'ITU-R BS.1770 K-weighted (approximation)',
      source: {
        label: r.label,
        sampleRate: r.sampleRate,
        channels: r.channels,
        analyzedChannels: r.analyzedChannels,
        channelWeights: r.channelWeights,
        durationSec: r.durationSec
      },
      results: {
        integratedLUFS: isFinite(r.integratedLUFS) ? r.integratedLUFS : null,
        silence: !isFinite(r.integratedLUFS),
        windowSec: state.windowSec,
        windowCurve: curve.times.map(function (t, i) {
          return { t: +t.toFixed(3), lufs: isFinite(curve.values[i]) ? +curve.values[i].toFixed(3) : null };
        }),
        samplePeakDbFS: isFinite(r.samplePeakDbFS) ? r.samplePeakDbFS : null,
        truePeak: r.truePeak.map(function (p) {
          return { dBTP: isFinite(p.dBTP) ? p.dBTP : null, timeSec: p.timeSec };
        }),
        clipSpans: r.clipSpans,
        targetLUFS: target,
        suggestedGainDb: g.applicable ? g.gainDb : null,
        gainNote: g.reason
      },
      warnings: r.warnings,
      note: '增益仅为建议值，原文件未被修改。'
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    download(blob, baseName(r.label) + '_loudness-report.json');
    setStatus('已导出分析结果 JSON。');
  }

  // Renders a gained copy and downloads it under a NEW filename; the source
  // file on disk is never touched.
  async function exportGainedCopy() {
    if (!state.result || !state.buffer) return;
    var g = DSP.gainToTarget(state.result.integratedLUFS, targetLoudness());
    if (!g.applicable) { setStatus('静音信号不应用增益。'); return; }
    setStatus('渲染增益副本…');
    var rendered = await Analyzer.renderGainedCopy(state.buffer, g.gainDb);
    var name = baseName(state.label) + '_gain' + (g.gainDb >= 0 ? '+' : '') +
      g.gainDb.toFixed(1) + 'dB.wav';
    download(WavEncoder.encodeWav(rendered), name);
    setStatus('已导出新文件 ' + name + '（原文件未修改）。');
  }

  window.addEventListener('resize', function () {
    if (state.result) updateView();
  });

  document.addEventListener('DOMContentLoaded', bindInputs);
})();
