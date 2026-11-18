import type { Frame, RGB } from '../types';

export type BackgroundMode = 'checker' | 'solid' | 'gradient';

function backgroundPixel(x: number, y: number, w: number, mode: BackgroundMode, solid: RGB): [number, number, number] {
  if (mode === 'solid') return [solid.r, solid.g, solid.b];
  if (mode === 'gradient') {
    const t = x / w;
    return [40 + 180 * t, 30 + 60 * (1 - t), 90 + 120 * (1 - t)];
  }
  const cell = 14;
  const on = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
  return on ? [214, 214, 214] : [120, 120, 120];
}

/** 抠像前景 over 新背景，输出可直接 putImageData 的 RGBA */
export function compositeOverBackground(
  frame: Frame,
  despilled: Uint8ClampedArray,
  mode: BackgroundMode,
  solid: RGB
): Uint8ClampedArray {
  const n = frame.width * frame.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const x = i % frame.width;
    const y = (i / frame.width) | 0;
    const [br, bg, bb] = backgroundPixel(x, y, frame.width, mode, solid);
    const a = despilled[o + 3] / 255;
    out[o] = despilled[o] * a + br * (1 - a);
    out[o + 1] = despilled[o + 1] * a + bg * (1 - a);
    out[o + 2] = despilled[o + 2] * a + bb * (1 - a);
    out[o + 3] = 255;
  }
  return out;
}
