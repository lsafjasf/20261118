// 四类指标时间对齐图表：四条泳道共享同一时间轴，卡顿区间整体着色。
import { CATEGORY_LABELS } from "./stats-normalize.js";

const LANE_COLORS = {
  network: "#f0b35e",
  decode: "#5ecfe0",
  jitterBuffer: "#c08df0",
  render: "#f07ea8",
};

const LANES = [
  { key: "network", series: [
    { name: "丢包率%", pick: (s) => s.network.lossRate * 100 },
    { name: "抖动ms", pick: (s) => s.network.jitterMs },
  ]},
  { key: "decode", series: [
    { name: "解码ms/帧", pick: (s) => s.decode.decodeMs },
  ]},
  { key: "jitterBuffer", series: [
    { name: "缓冲延迟ms", pick: (s) => s.jitterBuffer.jbDelayMs },
  ]},
  { key: "render", series: [
    { name: "FPS", pick: (s) => s.render.fps },
    { name: "冻结ms", pick: (s) => s.render.freezeMs },
  ]},
];

function laneLayout(canvas) {
  const padL = 90, padR = 16, padT = 26, padB = 24;
  const laneH = (canvas.height - padT - padB) / LANES.length;
  return { padL, padR, padT, padB, laneH, plotW: canvas.width - padL - padR };
}

function xOf(t, t0, t1, L) {
  return L.padL + ((t - t0) / Math.max(t1 - t0, 1)) * L.plotW;
}

function drawIntervals(ctx, intervals, t0, t1, L, canvas, highlight) {
  for (const iv of intervals) {
    const x1 = xOf(Math.max(iv.start, t0), t0, t1, L);
    const x2 = xOf(Math.min(iv.end || t1, t1), t0, t1, L);
    ctx.fillStyle = highlight ? "rgba(240,80,80,0.22)" : "rgba(240,80,80,0.10)";
    ctx.fillRect(x1, L.padT, Math.max(x2 - x1, 2), canvas.height - L.padT - L.padB);
  }
}

export function drawChart(canvas, samples, intervals, opts = {}) {
  const ctx = canvas.getContext("2d");
  const L = laneLayout(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!samples.length) return;
  const t0 = opts.t0 ?? samples[0].t;
  const t1 = opts.t1 ?? samples[samples.length - 1].t;

  drawIntervals(ctx, intervals, t0, t1, L, canvas, false);
  if (opts.evidence) {
    const x1 = xOf(Math.max(opts.evidence.from, t0), t0, t1, L);
    const x2 = xOf(Math.min(opts.evidence.to, t1), t0, t1, L);
    ctx.strokeStyle = "rgba(255,220,100,0.8)";
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x1, L.padT, x2 - x1, canvas.height - L.padT - L.padB);
    ctx.setLineDash([]);
  }

  ctx.font = "11px sans-serif";
  LANES.forEach((lane, i) => {
    const top = L.padT + i * L.laneH;
    ctx.strokeStyle = "#2a3550";
    ctx.strokeRect(L.padL, top, L.plotW, L.laneH);
    ctx.fillStyle = LANE_COLORS[lane.key];
    ctx.fillText(CATEGORY_LABELS[lane.key], 10, top + 14);

    lane.series.forEach((serie, si) => {
      const vals = samples.map(serie.pick);
      const max = Math.max(...vals, 1e-6);
      ctx.strokeStyle = si === 0 ? LANE_COLORS[lane.key] : "#8a94ad";
      ctx.beginPath();
      samples.forEach((s, j) => {
        const x = xOf(s.t, t0, t1, L);
        const y = top + L.laneH - 6 - (vals[j] / max) * (L.laneH - 14);
        j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(`${serie.name} (max ${max.toFixed(1)})`, L.padL + 6, top + 13 + si * 12);
    });
  });

  ctx.fillStyle = "#8a94ad";
  const ticks = 6;
  for (let i = 0; i <= ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / ticks;
    ctx.fillText((t / 1000).toFixed(0) + "s", xOf(t, t0, t1, L) - 6, canvas.height - 8);
  }
}

export function drawEvidence(canvas, evidence, interval) {
  drawChart(canvas, evidence.samples, [interval], {
    t0: evidence.from,
    t1: evidence.to,
  });
}
