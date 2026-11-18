import type { Frame, RGB } from '../types';

/** 对指定矩形区域做中位数采样，得到稳健的背景色估计 */
export function sampleBackground(
  frame: Frame,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): RGB {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const xa = Math.max(0, Math.min(x0, x1));
  const xb = Math.min(frame.width - 1, Math.max(x0, x1));
  const ya = Math.max(0, Math.min(y0, y1));
  const yb = Math.min(frame.height - 1, Math.max(y0, y1));

  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const o = (y * frame.width + x) * 4;
      rs.push(frame.image[o]);
      gs.push(frame.image[o + 1]);
      bs.push(frame.image[o + 2]);
    }
  }
  if (rs.length === 0) return { r: 0, g: 177, b: 0 };
  const median = (arr: number[]): number => {
    arr.sort((a, b) => a - b);
    return arr[arr.length >> 1];
  };
  return { r: median(rs), g: median(gs), b: median(bs) };
}

/** 默认采样四角中最像绿幕的区域 */
export function autoSample(frame: Frame): RGB {
  const w = frame.width;
  const h = frame.height;
  const k = Math.max(8, Math.round(Math.min(w, h) * 0.08));
  const candidates = [
    sampleBackground(frame, 2, 2, k, k),
    sampleBackground(frame, w - k - 2, 2, w - 3, k),
    sampleBackground(frame, 2, h - k - 2, k, h - 3),
    sampleBackground(frame, w - k - 2, h - k - 2, w - 3, h - 3),
    // 中心附近通常是最均匀的绿幕区，暗角会拉偏角落实采样
    sampleBackground(frame, (w >> 1) - (k >> 1), 4, (w >> 1) + (k >> 1), k + 4)
  ];
  const greenness = (c: RGB): number => c.g - (c.r + c.b) * 0.5;
  candidates.sort((a, b) => greenness(b) - greenness(a));
  return candidates[0];
}
