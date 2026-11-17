/* 合成测试片：正常静物 / 运动中插入重复帧 / 低光噪声 / 周期运动。
   输出 webm（MediaRecorder）+ 含已知冻结区间的 JSON 真值。
   所有渲染按墙钟时间推进，冻结窗口内直接重绘同一帧（含缓存噪声），
   保证“重复帧”是像素级重复而非仅物体停住。 */
(function (root) {
  "use strict";

  var VFA = root.VFA || (root.VFA = {});
  var Generator = VFA.Generator || (VFA.Generator = {});
  VFA.Generator = Generator;

  var W = 320, H = 180, FPS = 25;
  var SEGMENTS = [
    { name: "still", start: 0.0, end: 4.2, label: "正常静物" },
    { name: "motion", start: 4.2, end: 8.4, label: "运动中插入重复帧" },
    { name: "lowlight", start: 8.4, end: 12.6, label: "低光噪声" },
    { name: "periodic", start: 12.6, end: 16.8, label: "周期运动" }
  ];
  var FREEZE_MOTION = { t0: 5.2, t1: 7.0, segment: "motion" };
  var FREEZE_LOWLIGHT = { t0: 10.8, t1: 12.2, segment: "lowlight" };

  Generator.groundTruth = function () {
    return {
      schema: "vfa-groundtruth/v1",
      clip: "vfa-synthetic-test",
      width: W, height: H, fps: FPS,
      duration: SEGMENTS[SEGMENTS.length - 1].end,
      segments: SEGMENTS,
      freezes: [FREEZE_MOTION, FREEZE_LOWLIGHT],
      notes: [
        "still 段为正常静止镜头，期望标记 uncertain 而非 freeze",
        "periodic 段为正弦周期运动，折返点静止不得判为故障",
        "lowlight 冻结窗口内连传感器噪声一并停止",
        "边界误差评估容差 0.3s"
      ],
      boundaryTolerance: 0.3
    };
  };

  function inWindow(t, win) {
    return t >= win.t0 && t < win.t1;
  }

  function drawBackground(ctx, color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
  }

  function drawStill(ctx, t, state) {
    drawBackground(ctx, "#243047");
    ctx.fillStyle = "#d8a657";
    ctx.fillRect(70, 45, 90, 90);
    ctx.fillStyle = "#7fb3ff";
    ctx.beginPath();
    ctx.arc(220, 95, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9adbad";
    ctx.fillRect(150, 120, 60, 30);
  }

  function drawMotion(ctx, t, state) {
    drawBackground(ctx, "#1d2840");
    if (inWindow(t, FREEZE_MOTION)) {
      if (!state.frozenMotion) {
        state.frozenMotion = ctx.getImageData(0, 0, W, H);
      }
      ctx.putImageData(state.frozenMotion, 0, 0);
      return;
    }
    state.frozenMotion = null;
    var local = t - 4.2;
    var bx = 40 + ((local * 90) % 250);
    var by = 90 + Math.sin(local * 3.2) * 45;
    ctx.fillStyle = "#ef6f6c";
    ctx.beginPath();
    ctx.arc(bx, by, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(245, 90);
    ctx.rotate(local * 2.1);
    ctx.fillStyle = "#e8b34b";
    ctx.fillRect(-26, -26, 52, 52);
    ctx.restore();
  }

  function renderNoise(ctx, state, t) {
    var img = state.noiseImg;
    var data = img.data;
    var rnd = VFA.lcg(20261118 + state.noiseFrame * 7919);
    for (var i = 0; i < data.length; i += 4) {
      var n = rnd() * 26;
      data[i] = 6 + n;
      data[i + 1] = 8 + n;
      data[i + 2] = 14 + n;
      data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawLowlight(ctx, t, state) {
    if (!state.noiseImg) state.noiseImg = ctx.createImageData(W, H);
    var frozen = inWindow(t, FREEZE_LOWLIGHT);
    if (frozen) {
      if (!state.frozenNoise) {
        renderNoise(ctx, state, t);
        state.frozenNoise = ctx.getImageData(0, 0, W, H);
        state.frozenDot = Object.assign({}, state.dot);
      }
      ctx.putImageData(state.frozenNoise, 0, 0);
    } else {
      state.frozenNoise = null;
      state.noiseFrame++;
      renderNoise(ctx, state, t);
    }
    var local = t - 8.4;
    var dot = frozen ? state.frozenDot
      : (state.dot = { x: 60 + (local * 55) % 220, y: 110 + Math.sin(local * 2) * 30 });
    ctx.fillStyle = "rgba(180,200,255,0.85)";
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPeriodic(ctx, t, state) {
    drawBackground(ctx, "#20263a");
    var local = t - 12.6;
    var period = 2.0;
    var phase = (local % period) / period * Math.PI * 2;
    var x = W / 2 + Math.cos(phase) * 110;
    var y = H / 2 + Math.sin(phase * 2) * 35;
    ctx.fillStyle = "#4cc38a";
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#5aa7ff";
    ctx.fillRect(20, 150, 280, 4);
  }

  function renderFrame(ctx, t, state) {
    if (t < 4.2) drawStill(ctx, t, state);
    else if (t < 8.4) drawMotion(ctx, t, state);
    else if (t < 12.6) drawLowlight(ctx, t, state);
    else drawPeriodic(ctx, t, state);
  }

  function pickMime() {
    var candidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm"
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  /* 录制并返回 {blob, mimeType}。onProgress(0..1) 可选。 */
  Generator.record = function (onProgress) {
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      var duration = SEGMENTS[SEGMENTS.length - 1].end;
      var stream = canvas.captureStream(FPS);
      var mime = pickMime();
      var recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      var chunks = [];
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onerror = function (e) { reject(e.error || new Error("录制失败")); };
      recorder.onstop = function () {
        resolve({
          blob: new Blob(chunks, { type: mime || "video/webm" }),
          mimeType: mime || "video/webm"
        });
      };

      var state = { noiseFrame: 0 };
      var start = null;
      recorder.start(200);
      function frame(now) {
        if (start == null) start = now;
        var t = (now - start) / 1000;
        if (t >= duration) {
          renderFrame(ctx, duration - 0.02, state);
          setTimeout(function () { recorder.stop(); }, 120);
          return;
        }
        renderFrame(ctx, t, state);
        if (onProgress) onProgress(Math.min(1, t / duration));
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Generator;
  }
})(typeof window !== "undefined" ? window : globalThis);
