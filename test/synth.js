/* 合成灰度帧，模拟四类测试场景，供纯逻辑测试使用。 */
"use strict";

var W = 80, H = 45, STEP = 0.1;

function frame(t, luma) {
  return { t: t, w: W, h: H, luma: luma };
}

function movingFrame(t, rnd) {
  var luma = new Uint8Array(W * H);
  var shift = Math.floor(t * 24) % W;
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var stripe = ((x + shift) % 24 < 12) ? 90 : 50;
      luma[y * W + x] = stripe + Math.round((y / H) * 40);
    }
  }
  for (var k = 0; k < 60; k++) {
    luma[rnd() * (W * H) | 0] = 200;
  }
  return luma;
}

function stillFrame() {
  var luma = new Uint8Array(W * H);
  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      luma[y * W + x] = 60 + Math.round(80 * Math.abs(x / W - 0.5)) +
        Math.round(40 * Math.abs(y / H - 0.5));
    }
  }
  return luma;
}

function lowNoiseFrame(t, rnd) {
  var luma = new Uint8Array(W * H);
  var base = 12 + (rnd() * 4);
  for (var i = 0; i < W * H; i++) {
    luma[i] = base + (rnd() * 18 | 0);
  }
  var dotX = 20 + Math.floor((t * 30) % 40);
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      var x = dotX + dx, y = 22 + dy;
      if (x >= 0 && x < W && y >= 0 && y < H) luma[y * W + x] = 90;
    }
  }
  return luma;
}

/* 与 generator.js 时间轴保持一致。 */
function buildClip() {
  var rnd = (function (s) {
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  })(42);

  var still = stillFrame();
  var frozenMotion = movingFrame(5.2, rnd);
  var frozenNoise = lowNoiseFrame(10.8, rnd);
  var frames = [];
  for (var k = 0; k <= 168; k++) {
    var t = +(k * STEP).toFixed(3);
    var luma;
    if (t < 4.2) {
      luma = still;
    } else if (t >= 5.2 && t < 7.0) {
      luma = frozenMotion;
    } else if (t < 8.4) {
      luma = movingFrame(t, rnd);
    } else if (t >= 10.8 && t < 12.2) {
      luma = frozenNoise;
    } else if (t < 12.6) {
      luma = lowNoiseFrame(t, rnd);
    } else {
      /* 周期运动：2s 周期的正弦位移。 */
      luma = new Uint8Array(W * H);
      var local = t - 12.6;
      var cx = Math.round(W / 2 + Math.cos((local % 2) / 2 * Math.PI * 2) * 28);
      for (var y2 = 0; y2 < H; y2++) {
        for (var x2 = 0; x2 < W; x2++) {
          luma[y2 * W + x2] = 30;
        }
      }
      for (var d = -3; d <= 3; d++) {
        if (cx + d >= 0 && cx + d < W) {
          for (var yy = 18; yy < 27; yy++) luma[yy * W + cx + d] = 170;
        }
      }
    }
    frames.push(frame(t, luma));
  }
  return { frames: frames, width: W, height: H, step: STEP };
}

module.exports = { buildClip: buildClip, W: W, H: H, STEP: STEP };
