/* DOM 事件装配：把各模块连起来。 */
(function (root) {
  "use strict";

  var VFA = root.VFA;
  var App = VFA.App, UI = VFA.UI;

  function el(id) { return document.getElementById(id); }

  function showPanels() {
    el("panel-results").hidden = false;
    el("panel-eval").hidden = false;
    el("panel-review").hidden = false;
  }

  function refreshAll() {
    UI.drawTimeline();
    UI.renderCandidates();
    UI.renderReview();
  }

  /* ---------- 视频载入 ---------- */
  el("file-input").addEventListener("change", function (ev) {
    var file = ev.target.files[0];
    if (!file) return;
    App.loadVideoFile(file).catch(function (err) { alert(err.message); });
  });

  el("gt-input").addEventListener("change", function (ev) {
    var file = ev.target.files[0];
    if (!file) return;
    VFA.readJSONFile(file).then(function (data) {
      App.state.groundTruth = data;
      refreshAll();
      if (App.state.sweep) UI.renderSweep(App.state.sweep, data);
    }).catch(function (err) { alert("真值解析失败：" + err.message); });
  });

  el("btn-load-gt").addEventListener("click", function () {
    el("gt-input").click();
  });

  /* ---------- 阈值预设 ---------- */
  el("cfg-preset").addEventListener("change", function () {
    App.syncThresholdInputs();
  });
  ["t-luma", "t-edge", "t-motion", "t-lowlight"].forEach(function (id) {
    el(id).addEventListener("input", function () {
      el("cfg-preset").value = "custom";
    });
  });

  /* ---------- 分析 ---------- */
  el("btn-analyze").addEventListener("click", function () {
    var cfg = App.readConfig();
    el("btn-analyze").disabled = true;
    el("btn-cancel").hidden = false;
    var progress = el("analyze-progress");

    var run;
    if (!App.state.frames.length) {
      run = App.sample(cfg, function (ratio, t, n) {
        progress.textContent = "取样中 " + (ratio * 100).toFixed(0) +
          "% · " + t + " · 已取 " + n + " 帧";
      }).then(function () {
        progress.textContent = "指标计算与区间检测…";
      });
    } else {
      run = Promise.resolve();
    }

    run.then(function () {
      App.analyze(cfg);
      showPanels();
      refreshAll();
      el("sweep-table").innerHTML = "";
      App.state.sweep = null;
      progress.textContent = "完成：共 " + App.state.frames.length +
        " 个取样点，" + App.state.merged.length + " 个候选区间";
    }).catch(function (err) {
      if (!err.canceled) alert("分析失败：" + err.message);
      progress.textContent = err.canceled ? "已取消，已取样数据保留" : "分析失败";
    }).then(function () {
      el("btn-analyze").disabled = false;
      el("btn-cancel").hidden = true;
    });
  });

  el("btn-cancel").addEventListener("click", function () {
    App.state.sampling = null;
  });

  /* 取样参数变化后强制重新取样。 */
  ["cfg-step", "cfg-width"].forEach(function (id) {
    el(id).addEventListener("change", function () {
      if (App.state.frames.length) {
        App.resetAnalysis();
        el("analyze-progress").textContent =
          "取样参数已修改，下次分析将重新取样。";
      }
    });
  });

  /* ---------- 候选卡片操作（事件委托） ---------- */
  el("candidate-list").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.dataset.id;
    var cand = App.state.merged.find(function (c) { return c.id === id; });
    if (!cand) return;

    if (btn.dataset.act === "seek") {
      var video = el("video");
      video.currentTime = cand.t0;
      video.play().catch(function () {});
      return;
    }
    if (btn.dataset.act === "confirm" || btn.dataset.act === "exclude") {
      var noteEl = el("candidate-list")
        .querySelector('[data-note="' + id + '"]');
      VFA.Review.upsertFromCandidate(
        App.state.reviewStore, cand,
        btn.dataset.act === "confirm" ? "confirmed" : "excluded",
        noteEl ? noteEl.value : ""
      );
      var applied = VFA.Review.applyToCandidates(
        App.state.reviewStore, App.state.result.intervals
      );
      App.state.merged = applied.merged;
      App.state.orphans = applied.orphans;
      refreshAll();
      return;
    }
    if (btn.dataset.act === "clear") {
      if (cand.annotation) {
        VFA.Review.remove(App.state.reviewStore, cand.annotation.id);
        var next = VFA.Review.applyToCandidates(
          App.state.reviewStore, App.state.result.intervals
        );
        App.state.merged = next.merged;
        App.state.orphans = next.orphans;
        refreshAll();
      }
    }
  });

  el("candidate-list").addEventListener("change", function (ev) {
    var ta = ev.target.closest("textarea[data-note]");
    if (!ta) return;
    var id = ta.dataset.note;
    var cand = App.state.merged.find(function (c) { return c.id === id; });
    if (cand && cand.annotation) {
      VFA.Review.updateNote(App.state.reviewStore, cand.annotation.id, ta.value);
    }
  });

  el("review-list").addEventListener("click", function (ev) {
    var btn = ev.target.closest('button[data-act="del-orphan"]');
    if (!btn) return;
    VFA.Review.remove(App.state.reviewStore, btn.dataset.id);
    var applied = VFA.Review.applyToCandidates(
      App.state.reviewStore, App.state.result.intervals
    );
    App.state.merged = applied.merged;
    App.state.orphans = applied.orphans;
    refreshAll();
  });

  /* ---------- 阈值扫描 ---------- */
  el("btn-sweep").addEventListener("click", function () {
    if (!App.state.pairs.length) {
      alert("请先完成一次分析。");
      return;
    }
    var minDuration = parseFloat(el("cfg-min-dur").value);
    App.state.sweep = VFA.Evaluate.sweep(
      App.state.frames, App.state.pairs,
      VFA.PRESETS, minDuration, App.state.groundTruth
    );
    UI.renderSweep(App.state.sweep, App.state.groundTruth);
  });

  window.addEventListener("resize", function () {
    if (App.state.result) UI.drawTimeline();
  });

  /* ---------- 导出 / 导入 ---------- */
  function exportPayload() {
    return {
      video: {
        name: App.state.videoName,
        duration: App.state.duration
      },
      sampling: {
        step: App.state.lastConfig.step,
        analysisWidth: App.state.lastConfig.analysisWidth,
        frameCount: App.state.frames.length,
        grid: App.state.grid
      },
      thresholds: {
        luma: App.state.lastConfig.luma,
        edge: App.state.lastConfig.edge,
        motion: App.state.lastConfig.motion,
        lowlight: App.state.lastConfig.lowlight,
        minDuration: App.state.lastConfig.minDuration
      },
      periodicity: App.state.result.periodicity,
      intervals: App.state.merged,
      store: App.state.reviewStore
    };
  }

  el("btn-export-json").addEventListener("click", function () {
    if (!App.state.result) return;
    VFA.download(
      "vfa-result-" + Date.now() + ".json",
      VFA.Review.toExportJSON(exportPayload()),
      "application/json"
    );
  });

  el("btn-export-csv").addEventListener("click", function () {
    if (!App.state.result) return;
    VFA.download(
      "vfa-intervals-" + Date.now() + ".csv",
      VFA.Review.toCSV(App.state.merged),
      "text/csv"
    );
  });

  el("btn-export-report").addEventListener("click", function () {
    if (!App.state.result) return;
    VFA.download(
      "vfa-report-" + Date.now() + ".html",
      VFA.Review.toHTMLReport(exportPayload()),
      "text/html"
    );
  });

  el("btn-export-anno").addEventListener("click", function () {
    VFA.download(
      "vfa-annotations-" + Date.now() + ".json",
      VFA.Review.toAnnotationJSON(App.state.reviewStore),
      "application/json"
    );
  });

  el("btn-import-anno").addEventListener("click", function () {
    el("anno-input").click();
  });

  el("anno-input").addEventListener("change", function (ev) {
    var file = ev.target.files[0];
    if (!file) return;
    VFA.readJSONFile(file).then(function (data) {
      VFA.Review.loadAnnotationJSON(App.state.reviewStore, data);
      if (App.state.result) {
        var applied = VFA.Review.applyToCandidates(
          App.state.reviewStore, App.state.result.intervals
        );
        App.state.merged = applied.merged;
        App.state.orphans = applied.orphans;
        refreshAll();
      }
      alert("已导入 " + data.annotations.length + " 条人工标注。");
    }).catch(function (err) { alert(err.message); });
  });

  /* ---------- 测试片生成 ---------- */
  el("btn-generate").addEventListener("click", function () {
    var btn = el("btn-generate");
    btn.disabled = true;
    var progress = el("analyze-progress");
    VFA.Generator.record(function (ratio) {
      progress.textContent = "测试片录制中 " + (ratio * 100).toFixed(0) + "%";
    }).then(function (rec) {
      var gt = VFA.Generator.groundTruth();
      var clipName = "vfa-synthetic-test.webm";
      VFA.download(clipName, rec.blob, rec.mimeType);
      VFA.download(
        "vfa-synthetic-test.groundtruth.json",
        JSON.stringify(gt, null, 2),
        "application/json"
      );
      App.state.groundTruth = gt;
      progress.textContent = "测试片与真值 JSON 已下载，可选择该 webm 后直接分析。";
    }).catch(function (err) {
      alert("测试片生成失败：" + err.message);
    }).then(function () {
      btn.disabled = false;
    });
  });
})(typeof window !== "undefined" ? window : globalThis);
