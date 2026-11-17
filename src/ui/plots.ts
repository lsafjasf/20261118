/** Canvas plotting: magnitude, phase, impulse response, residual. */

const COLORS = {
  bg: "#101418",
  grid: "#2a3138",
  axis: "#8a94a0",
  true: "#4fc3f7",
  est: "#ffb74d",
  residual: "#e57373",
  unreliable: "rgba(229, 115, 115, 0.14)",
  text: "#c9d1d9",
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function setup(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; plot: Rect } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  const plot = { x: 52, y: 10, w: w - 62, h: h - 34 };
  ctx.font = "10px system-ui, sans-serif";
  return { ctx, plot };
}

function shadeUnreliable(
  ctx: CanvasRenderingContext2D,
  plot: Rect,
  freqs: Float64Array,
  reliable: boolean[],
  toX: (f: number) => number,
): void {
  ctx.fillStyle = COLORS.unreliable;
  let start = -1;
  for (let k = 0; k < freqs.length; k++) {
    if (!reliable[k] && start < 0) start = k;
    const end = reliable[k] || k === freqs.length - 1;
    if (start >= 0 && end) {
      const x0 = toX(freqs[start]);
      const x1 = toX(freqs[k]);
      ctx.fillRect(x0, plot.y, Math.max(1, x1 - x0), plot.h);
      start = -1;
    }
  }
}

function logFreqAxis(ctx: CanvasRenderingContext2D, plot: Rect, fMin: number, fMax: number) {
  const toX = (f: number) =>
    plot.x + (plot.w * (Math.log10(f) - Math.log10(fMin))) / (Math.log10(fMax) - Math.log10(fMin));
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "center";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f < fMin || f > fMax) continue;
    const x = toX(f);
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x, plot.y + plot.h + 12);
  }
  return toX;
}

function traceSeries(
  ctx: CanvasRenderingContext2D,
  xs: Float64Array,
  ys: Float64Array,
  mask: boolean[] | null,
  toX: (x: number) => number,
  toY: (y: number) => number,
  color: string,
  dash: number[] = [],
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let pen = false;
  for (let k = 0; k < xs.length; k++) {
    if (mask && !mask[k]) {
      pen = false;
      continue;
    }
    const x = toX(xs[k]);
    const y = toY(ys[k]);
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

export interface FreqPlotData {
  freqs: Float64Array;
  trueVals: Float64Array;
  estVals: Float64Array;
  reliable: boolean[];
  fMin: number;
  fMax: number;
  yMin: number;
  yMax: number;
  yLabel: string;
  yTicks: number[];
}

export function drawFreqPlot(canvas: HTMLCanvasElement, d: FreqPlotData): void {
  const { ctx, plot } = setup(canvas);
  const toX = logFreqAxis(ctx, plot, d.fMin, d.fMax);
  const toY = (v: number) => plot.y + plot.h * (1 - (v - d.yMin) / (d.yMax - d.yMin));
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "right";
  for (const t of d.yTicks) {
    const y = toY(t);
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillText(`${t}`, plot.x - 5, y + 3);
  }
  shadeUnreliable(ctx, plot, d.freqs, d.reliable, toX);
  traceSeries(ctx, d.freqs, d.trueVals, null, toX, toY, COLORS.true);
  traceSeries(ctx, d.freqs, d.estVals, d.reliable, toX, toY, COLORS.est);
  ctx.strokeStyle = COLORS.axis;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "left";
  ctx.fillText(d.yLabel, plot.x + 4, plot.y + 12);
  legend(ctx, plot);
}

function legend(ctx: CanvasRenderingContext2D, plot: Rect): void {
  ctx.textAlign = "right";
  ctx.fillStyle = COLORS.true;
  ctx.fillText("— 真实", plot.x + plot.w - 60, plot.y + 12);
  ctx.fillStyle = COLORS.est;
  ctx.fillText("— 估计", plot.x + plot.w - 10, plot.y + 12);
}

export interface TimePlotData {
  sampleRate: number;
  trueIR: ArrayLike<number>;
  estIR: ArrayLike<number>;
  tMaxMs: number;
}

export function drawImpulsePlot(canvas: HTMLCanvasElement, d: TimePlotData): void {
  const { ctx, plot } = setup(canvas);
  const n = Math.min(d.trueIR.length, d.estIR.length);
  const tMaxSamples = Math.min(n, Math.round((d.tMaxMs / 1000) * d.sampleRate));
  let peak = 1e-9;
  for (let i = 0; i < tMaxSamples; i++) {
    peak = Math.max(peak, Math.abs(d.trueIR[i]), Math.abs(d.estIR[i]));
  }
  const toX = (i: number) => plot.x + (plot.w * i) / (tMaxSamples - 1);
  const toY = (v: number) => plot.y + plot.h * (0.5 - 0.45 * (v / peak));
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(plot.x, toY(0));
  ctx.lineTo(plot.x + plot.w, toY(0));
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "center";
  for (let ms = 0; ms <= d.tMaxMs; ms += Math.max(1, Math.round(d.tMaxMs / 6))) {
    const i = (ms / 1000) * d.sampleRate;
    if (i > tMaxSamples) continue;
    ctx.fillText(`${ms}ms`, toX(i), plot.y + plot.h + 12);
  }
  const idx = Float64Array.from({ length: tMaxSamples }, (_, i) => i);
  const tArr = Float64Array.from({ length: tMaxSamples }, (_, i) => d.trueIR[i]);
  const eArr = Float64Array.from({ length: tMaxSamples }, (_, i) => d.estIR[i]);
  traceSeries(ctx, idx, tArr, null, toX, toY, COLORS.true);
  traceSeries(ctx, idx, eArr, null, toX, toY, COLORS.est);
  ctx.strokeStyle = COLORS.axis;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  legend(ctx, plot);
}

export function drawResidualPlot(
  canvas: HTMLCanvasElement,
  residual: Float64Array,
  sampleRate: number,
): void {
  const { ctx, plot } = setup(canvas);
  const n = residual.length;
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(residual[i]));
  const toX = (i: number) => plot.x + (plot.w * i) / (n - 1);
  const toY = (v: number) => plot.y + plot.h * (0.5 - 0.45 * (v / peak));
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  ctx.moveTo(plot.x, toY(0));
  ctx.lineTo(plot.x + plot.w, toY(0));
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "center";
  const totalSec = n / sampleRate;
  for (let s = 0; s <= totalSec; s += Math.max(0.5, Math.round(totalSec / 6))) {
    ctx.fillText(`${s.toFixed(1)}s`, toX(s * sampleRate), plot.y + plot.h + 12);
  }
  // downsample to pixel columns for speed
  ctx.strokeStyle = COLORS.residual;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const cols = Math.floor(plot.w);
  for (let c = 0; c <= cols; c++) {
    const i0 = Math.floor((c / cols) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / cols) * n));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i < i1 && i < n; i++) {
      if (residual[i] < lo) lo = residual[i];
      if (residual[i] > hi) hi = residual[i];
    }
    const x = plot.x + c;
    ctx.moveTo(x, toY(lo));
    ctx.lineTo(x, toY(hi));
  }
  ctx.stroke();
  ctx.strokeStyle = COLORS.axis;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = "left";
  ctx.fillText("重建残差 y − x∗ĥ", plot.x + 4, plot.y + 12);
}
