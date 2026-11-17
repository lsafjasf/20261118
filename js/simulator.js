// 故障场景模拟器：生成与 getStats 归一化后同构的样本流。
// 两种场景内置因果时序：
//   bandwidth  —— 丢包先升 -> 抖动 -> 抖动缓冲 -> 渲染卡顿
//   mainthread —— 渲染等待先升 -> 解码排队 -> 抖动缓冲被动增长
// 使用种子随机数保证结果可复现，便于无头验证“最先升高的指标”。

import { emptySample } from "./stats-normalize.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tau 到达 atMs 后从 0 平滑爬升到 1（riseMs 内完成）
function ramp(tauMs, atMs, riseMs = 800) {
  if (tauMs <= atMs) return 0;
  return Math.min(1, (tauMs - atMs) / riseMs);
}

const BASELINE = {
  lossRate: 0.003, jitterMs: 8, rttMs: 40,
  decodeMs: 4, jbDelayMs: 40, fps: 30,
};

export class FaultSimulator {
  constructor({ dtMs = 500, seed = 42 } = {}) {
    this.dtMs = dtMs;
    this.rand = mulberry32(seed);
    this.t = 0;
    this.fault = null;
  }

  inject(kind, durationMs = 20_000) {
    this.fault = { kind, start: this.t, duration: durationMs };
  }

  get faultTau() {
    if (!this.fault) return -1;
    const tau = this.t - this.fault.start;
    return tau <= this.fault.duration ? tau : -1;
  }

  noise(amp) {
    return (this.rand() - 0.5) * 2 * amp;
  }

  next() {
    this.t += this.dtMs;
    const s = emptySample(this.t);
    const tau = this.faultTau;
    const b = BASELINE;

    s.network.lossRate = Math.max(0, b.lossRate + this.noise(0.002));
    s.network.jitterMs = Math.max(1, b.jitterMs + this.noise(3));
    s.network.rttMs = Math.max(5, b.rttMs + this.noise(8));
    s.decode.decodeMs = Math.max(0.5, b.decodeMs + this.noise(1));
    s.jitterBuffer.jbDelayMs = Math.max(5, b.jbDelayMs + this.noise(8));
    s.render.fps = Math.max(1, b.fps + this.noise(2));
    s.render.droppedDelta = this.rand() < 0.05 ? 1 : 0;
    s.render.freezeMs = 0;

    if (tau >= 0 && this.fault.kind === "bandwidth") {
      s.network.lossRate += 0.09 * ramp(tau, 500);
      s.network.jitterMs += 55 * ramp(tau, 1000);
      s.network.rttMs += 60 * ramp(tau, 1000);
      s.jitterBuffer.jbDelayMs += 200 * ramp(tau, 2000);
      s.decode.decodeMs += 2 * ramp(tau, 3000);
      const r = ramp(tau, 4000);
      s.render.fps = Math.max(2, s.render.fps - 26 * r);
      s.render.droppedDelta += Math.round(6 * r * (0.5 + this.rand()));
      s.render.freezeMs += 450 * r * (0.5 + this.rand());
    } else if (tau >= 0 && this.fault.kind === "mainthread") {
      const r = ramp(tau, 500);
      s.render.fps = Math.max(2, s.render.fps - 27 * r);
      s.render.droppedDelta += Math.round(8 * r * (0.5 + this.rand()));
      s.render.freezeMs += 600 * r * (0.5 + this.rand());
      s.decode.decodeMs += 22 * ramp(tau, 1500);
      s.jitterBuffer.jbDelayMs += 90 * ramp(tau, 3000);
    }
    return s;
  }
}
