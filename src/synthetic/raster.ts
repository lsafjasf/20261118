export type RGB8 = [number, number, number];

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 场景层的直色与覆盖度（0..1），逐像素求值 */
export interface LayerSample {
  coverage: number;
  color: RGB8;
  /** 该层是否为“前景自身接近背景色”的歧义源 */
  ambiguous?: boolean;
}

export const noLayer: LayerSample = { coverage: 0, color: [0, 0, 0] };

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 带 1px 抗锯齿的圆覆盖度 */
export function circleCoverage(x: number, y: number, cx: number, cy: number, r: number): number {
  const d = Math.hypot(x - cx, y - cy);
  return clamp01(r + 0.5 - d);
}

export function roundedRectCoverage(
  x: number,
  y: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rad: number
): number {
  const nx = Math.max(x0 + rad, Math.min(x, x0 + w - rad));
  const ny = Math.max(y0 + rad, Math.min(y, y0 + h - rad));
  const d = Math.hypot(x - nx, y - ny);
  return clamp01(rad + 0.5 - d);
}

/** 有宽度的线段，距离场覆盖度 */
export function lineCoverage(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy || 1e-9;
  const t = clamp01(((x - ax) * vx + (y - ay) * vy) / len2);
  const px = ax + t * vx;
  const py = ay + t * vy;
  const d = Math.hypot(x - px, y - py);
  return clamp01(width * 0.5 + 0.5 - d);
}

export function ellipseCoverage(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number
): number {
  const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  return clamp01(1.5 - q);
}
