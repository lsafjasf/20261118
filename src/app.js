/* Glue UI: fixture generation, VAD run, editable segments, live metrics. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = {
    samples: null,
    sampleRate: 16000,
    duration: 0,
    feature: null,
    vad: null,
    reference: null,
    segments: [],
    audioUrl: null,
    audio: null
  };

  let timeline;

  function fmt(sec) {
    return sec.toFixed(3) + " s";
  }

  function renderTotals(segments) {
    const t = Metrics.totalsByLabel(segments);
    $("total-speech").textContent = t.speechSec.toFixed(3);
    $("total-noise").textContent = t.noiseSec.toFixed(3);
    $("total-silence").textContent = t.silenceSec.toFixed(3);
    $("total-all").textContent = t.totalSec.toFixed(3);
  }

  function renderSegmentRows(segments) {
    const tbody = $("segment-rows");
    tbody.innerHTML = "";
    segments.forEach((s, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        '<td>' + (i + 1) + "</td>" +
        '<td><span class="dot dot-' + s.label + '"></span>' + s.label + "</td>" +
        '<td contenteditable="true" class="edit-start">' + s.start.toFixed(3) + "</td>" +
        '<td contenteditable="true" class="edit-end">' + s.end.toFixed(3) + "</td>" +
        '<td class="dur">' + (s.end - s.start).toFixed(3) + "</td>";
      tbody.appendChild(tr);
      tr.querySelector(".edit-start").addEventListener("blur", () => {
        const v = parseFloat(tr.querySelector(".edit-start").textContent);
        if (Number.isFinite(v)) setBoundary(i, "start", v);
      });
      tr.querySelector(".edit-end").addEventListener("blur", () => {
        const v = parseFloat(tr.querySelector(".edit-end").textContent);
        if (Number.isFinite(v)) setBoundary(i, "end", v);
      });
    });
  }

  function setBoundary(index, which, value) {
    const segs = state.segments;
    const minDur = 0.02;
    const t = Math.max(0, Math.min(state.duration, value));
    if (which === "start") {
      const lower = segs[index - 1] ? segs[index - 1].start + minDur : 0;
      const nt = Math.max(lower, Math.min(segs[index].end - minDur, t));
      if (segs[index - 1]) segs[index - 1].end = nt;
      segs[index].start = nt;
    } else {
      const upper = segs[index + 1] ? segs[index + 1].end - minDur : state.duration;
      const nt = Math.max(segs[index].start + minDur, Math.min(upper, t));
      if (segs[index + 1]) segs[index + 1].start = nt;
      segs[index].end = nt;
    }
    refreshAfterEdit();
  }

  function refreshAfterEdit() {
    timeline.setSegments(state.segments);
    renderSegmentRows(state.segments);
    renderTotals(state.segments);
    renderMetrics();
  }

  function renderMetrics() {
    if (!state.reference) {
      $("metrics-body").innerHTML =
        '<p class="muted">上传素材无内置真值；加载固定测试素材可查看漏检/误检与边界偏差。</p>';
      return;
    }
    const hypFrameLabels = state.vad.labels.map((l) => (l === "speech" ? "speech" : "silence"));
    const m = Metrics.evaluate(state.reference, state.segments, state.feature.frames,
      { hypFrameLabels, toleranceSec: parseFloat($("tolerance").value) || 0.1 });
    const b = m.boundary;
    $("metrics-body").innerHTML =
      '<div class="metric"><span>漏检率 Miss</span><strong>' + m.missRate + '%</strong></div>' +
      '<div class="metric"><span>误检率 False Alarm</span><strong>' + m.falseAlarmRate + '%</strong></div>' +
      '<div class="metric"><span>帧准确率</span><strong>' + m.frameAccuracy + '%</strong></div>' +
      '<div class="metric"><span>平均边界偏差</span><strong>' +
        (b.meanAbsErrorSec === null ? "—" : (b.meanAbsErrorSec * 1000).toFixed(1) + " ms") +
      "</strong></div>" +
      '<div class="metric"><span>最大边界偏差</span><strong>' +
        (b.maxAbsErrorSec === null ? "—" : (b.maxAbsErrorSec * 1000).toFixed(1) + " ms") +
      "</strong></div>" +
      '<div class="metric"><span>匹配/漏/假边界</span><strong>' +
        b.matchedEdges + " / " + (b.bridgedEdges || 0) + " / " +
        b.missedEdges + " / " + b.falseEdges + "</strong></div>";
  }

  function renderThresholds(vad) {
    $("thresholds").textContent =
      "噪声地板 " + vad.thresholds.noiseDb.toFixed(1) + " dB ｜ 语音门限 " +
      vad.thresholds.speechEnergyThr.toFixed(1) + " dB ｜ 静音门限 " +
      vad.thresholds.silenceEnergyThr.toFixed(1) + " dB";
  }

  function setAudio(samples, sampleRate) {
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    const blob = WavCodec.encode(samples, sampleRate);
    state.audioUrl = URL.createObjectURL(blob);
    state.audio = $("player");
    state.audio.src = state.audioUrl;
  }

  function runPipeline(samples, sampleRate, reference) {
    state.samples = samples;
    state.sampleRate = sampleRate;
    state.duration = samples.length / sampleRate;
    state.reference = reference || null;
    state.feature = Features.extract(samples, { sampleRate });
    state.vad = VAD.analyze(state.feature);
    state.segments = state.vad.segments.map((s) => Object.assign({}, s));
    timeline._sampleRate = sampleRate;
    timeline.setData(samples, state.duration, state.segments);
    renderSegmentRows(state.segments);
    renderTotals(state.segments);
    renderThresholds(state.vad);
    renderMetrics();
    setAudio(samples, sampleRate);
  }

  function loadFixture() {
    const fx = TestSignal.generate();
    runPipeline(fx.samples, fx.sampleRate, fx.groundTruth);
    $("fixture-info").textContent = fx.description + "（" + fx.durationSec + " s，含 " +
      fx.events.length + " 次键盘点击，真值已内置）";
  }

  function exportSegments() {
    const payload = {
      durationSec: state.duration,
      sampleRate: state.sampleRate,
      segments: state.segments,
      totals: Metrics.totalsByLabel(state.segments)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "segments.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function init() {
    timeline = new Timeline($("timeline"), {
      onChange: (segs, live) => {
        state.segments = segs.map((s) => Object.assign({}, s));
        renderTotals(state.segments);
        if (!live) {
          renderSegmentRows(state.segments);
          renderMetrics();
        }
      }
    });
    $("btn-fixture").addEventListener("click", loadFixture);
    $("btn-export").addEventListener("click", exportSegments);
    $("tolerance").addEventListener("change", renderMetrics);
    $("file-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      const decoded = WavCodec.decode(buf);
      const samples = WavCodec.resampleTo16k(decoded.samples, decoded.sampleRate);
      runPipeline(samples, 16000, null);
      $("fixture-info").textContent = "已加载上传文件：" + file.name +
        "（重采样到 16 kHz，无内置真值）";
    });
    const audio = $("player");
    setInterval(() => {
      if (state.duration && !audio.paused) timeline.setPlayhead(audio.currentTime);
    }, 80);
    loadFixture();
  }

  window.addEventListener("DOMContentLoaded", init);
})();
