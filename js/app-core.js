/* 应用状态、视频载入与 HTMLVideoElement 逐时刻取样。
   取样基于 mediaTime（currentTime）定位，分析在离屏 Canvas 上进行。 */
(function (root) {
  "use strict";

  var VFA = root.VFA;
  var App = VFA.App || (VFA.App = {});
  VFA.App = App;

  App.state = {
    videoName: null,
    videoUrl: null,
    duration: 0,
    frames: [],
    pairs: [],
    grid: { cols: 16, rows: 9 },
    sampling: null,
    lastConfig: null,
    result: null,
    sweep: null,
    groundTruth: null,
    reviewStore: VFA.Review.createStore(),
    merged: [],
    orphans: []
  };

  App.readConfig = function () {
    var presetName = document.getElementById("cfg-preset").value;
    var preset = VFA.PRESETS[presetName] || VFA.PRESETS.standard;
    var custom = presetName === "custom";
    var num = function (id) { return parseFloat(document.getElementById(id).value); };
    return {
      step: num("cfg-step"),
      analysisWidth: parseInt(document.getElementById("cfg-width").value, 10),
      minDuration: num("cfg-min-dur"),
      preset: presetName,
      luma: custom ? num("t-luma") : preset.luma,
      edge: custom ? num("t-edge") : preset.edge,
      motion: custom ? num("t-motion") : preset.motion,
      lowlight: custom
        ? num("t-lowlight")
        : preset.lowlight,
      lowlightFactor: preset.lowlightFactor
    };
  };

  App.syncThresholdInputs = function () {
    var name = document.getElementById("cfg-preset").value;
    var p = VFA.PRESETS[name];
    if (!p) return;
    document.getElementById("t-luma").value = p.luma;
    document.getElementById("t-edge").value = p.edge;
    document.getElementById("t-motion").value = p.motion;
    document.getElementById("t-lowlight").value = p.lowlight;
  };

  App.loadVideoFile = function (file) {
    if (App.state.videoUrl) URL.revokeObjectURL(App.state.videoUrl);
    App.state.videoUrl = URL.createObjectURL(file);
    App.state.videoName = file.name;
    var video = document.getElementById("video");
    video.src = App.state.videoUrl;
    return new Promise(function (resolve, reject) {
      video.onloadedmetadata = function () {
        resolveDuration(video).then(function (duration) {
          App.state.duration = duration;
          App.resetAnalysis();
          document.getElementById("video-meta").textContent =
            file.name + " · " + VFA.fmtTime(duration) +
            " · " + video.videoWidth + "x" + video.videoHeight +
            (isFinite(video.duration) ? "" : "（时长由缓冲探测得到）");
          document.getElementById("btn-load-gt").hidden = false;
          resolve(video);
        }).catch(reject);
      };
      video.onerror = function () { reject(new Error("视频解码失败")); };
    });
  };

  /* MediaRecorder 产出的 webm 可能缺少时长索引（duration=Infinity）。
     通过缓冲末端或大跳转探测真实时长。 */
  function resolveDuration(video) {
    if (isFinite(video.duration)) return Promise.resolve(video.duration);
    return new Promise(function (resolve) {
      function fromBuffer() {
        var end = video.buffered.length
          ? video.buffered.end(video.buffered.length - 1)
          : 0;
        if (end > 0) return resolve(end);
        video.currentTime = 1e9;
        setTimeout(function () {
          var probe = video.buffered.length
            ? video.buffered.end(video.buffered.length - 1)
            : 0;
          resolve(probe || video.currentTime || 0);
        }, 600);
      }
      if (video.readyState >= 1) fromBuffer();
      else video.addEventListener("loadeddata", fromBuffer, { once: true });
    });
  }

  App.resetAnalysis = function () {
    App.state.frames = [];
    App.state.pairs = [];
    App.state.result = null;
    App.state.sweep = null;
    App.state.groundTruth = null;
    App.state.reviewStore = VFA.Review.createStore();
    App.state.reviewStore.videoName = App.state.videoName;
    App.state.merged = [];
    App.state.orphans = [];
    document.getElementById("panel-results").hidden = true;
    document.getElementById("panel-eval").hidden = true;
    document.getElementById("panel-review").hidden = true;
  };

  function seekTo(video, time) {
    return new Promise(function (resolve, reject) {
      function onSeeked() {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      }
      video.addEventListener("seeked", onSeeked);
      video.currentTime = Math.min(time, App.state.duration - 0.001);
      setTimeout(function () {
        video.removeEventListener("seeked", onSeeked);
        reject(new Error("seek 超时 @ " + time.toFixed(2) + "s"));
      }, 8000);
    });
  }

  /* 逐 mediaTime 取样。取消时 reject 一个带 canceled 标记的错误。 */
  App.sample = function (cfg, onProgress) {
    var video = document.getElementById("video");
    var width = cfg.analysisWidth;
    var ratio = video.videoHeight / video.videoWidth || 9 / 16;
    var height = Math.max(32, Math.round(width * ratio / 2) * 2);
    var canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var token = {};
    App.state.sampling = token;
    var frames = [];
    var times = [];
    for (var t = 0; t <= App.state.duration + 1e-6; t += cfg.step) {
      times.push(Math.min(t, App.state.duration));
    }

    return times.reduce(function (chain, time, idx) {
      return chain.then(function () {
        if (App.state.sampling !== token) {
          var canceled = new Error("已取消");
          canceled.canceled = true;
          throw canceled;
        }
        return seekTo(video, time).then(function () {
          ctx.drawImage(video, 0, 0, width, height);
          var imageData = ctx.getImageData(0, 0, width, height);
          var luma = VFA.Metrics.toLuma(imageData.data, width, height);
          frames.push({
            t: time,
            w: width,
            h: height,
            luma: luma
          });
          if (onProgress) {
            onProgress((idx + 1) / times.length, VFA.fmtTime(time), frames.length);
          }
        });
      });
    }, Promise.resolve()).then(function () {
      if (App.state.sampling !== token) {
        var canceled = new Error("已取消");
        canceled.canceled = true;
        throw canceled;
      }
      App.state.sampling = null;
      App.state.frames = frames;
      return frames;
    });
  };

  /* 指标只算一次，阈值重算走 evaluate.sweep 复用。 */
  App.analyze = function (cfg) {
    if (!App.state.frames.length) throw new Error("没有可用取样帧");
    var cols = App.state.grid.cols;
    var rows = App.state.grid.rows;
    App.state.pairs = VFA.Metrics.buildPairs(App.state.frames, cols, rows);
    var detectCfg = {
      luma: cfg.luma,
      edge: cfg.edge,
      motion: cfg.motion,
      lowlight: cfg.lowlight,
      lowlightFactor: cfg.lowlightFactor,
      minDuration: cfg.minDuration
    };
    var freshPairs = App.state.pairs.map(function (p) {
      return Object.assign({}, p, { blockDiffs: p.blockDiffs });
    });
    App.state.result = VFA.Detect.detect(
      App.state.frames, freshPairs, detectCfg
    );
    App.state.lastConfig = cfg;
    var applied = VFA.Review.applyToCandidates(
      App.state.reviewStore, App.state.result.intervals
    );
    App.state.merged = applied.merged;
    App.state.orphans = applied.orphans;
    return App.state.result;
  };
})(typeof window !== "undefined" ? window : globalThis);
