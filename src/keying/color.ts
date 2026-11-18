import type { RGB } from '../types';

/**
 * BT.601 色差坐标（去掉 128 偏移，直接以中性色为原点）。
 * 绿幕在该平面上与中性色/肤色距离明显，且对亮度起伏不敏感。
 */
export function chroma(r: number, g: number, b: number): { cb: number; cr: number } {
  return {
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b
  };
}

/** Rec.709 亮度 */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * 像素与背景色的键控距离：以色度为主、亮度为辅。
 * 纯色度无法区分“半透明前景覆在绿幕上”与绿幕本身
 * （二者色度接近但亮度不同），因此按 lumaWeight 混入亮度差，
 * 同时对绿幕自身的亮度不均匀保留足够容忍度。
 */
export function keyDistance(
  r: number,
  g: number,
  b: number,
  key: RGB,
  lumaWeight = 0.35
): number {
  const cd = chromaDistance(r, g, b, key);
  const ld = Math.abs(luma(r, g, b) - luma(key.r, key.g, key.b));
  return cd + lumaWeight * ld;
}

/** 像素与背景色在色度平面上的欧氏距离，量级约 0..110 */
export function chromaDistance(r: number, g: number, b: number, key: RGB): number {
  const p = chroma(r, g, b);
  const k = chroma(key.r, key.g, key.b);
  return Math.hypot(p.cb - k.cb, p.cr - k.cr);
}

/** 普通 RGB 欧氏距离（保留作对照） */
export function rgbDistance(r: number, g: number, b: number, key: RGB): number {
  return Math.hypot(r - key.r, g - key.g, b - key.b);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function rgbToCss(c: RGB): string {
  return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}
