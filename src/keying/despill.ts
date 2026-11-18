import type { KeyerParams } from '../types';
import { clamp } from './color';

/**
 * 绿色溢色抑制：把超过 r/b 均值的绿色通道压回均值，
 * 只作用在半透明边缘（软遮罩区域），不透明前景保持原色。
 * protect 为 1 的像素（保护区域）完全跳过。
 */
export function despillImage(
  image: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
  strength: number,
  protect: Uint8Array
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(image.length);
  const n = image.length / 4;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = image[o];
    const g = image[o + 1];
    const b = image[o + 2];
    const a = alpha[i];
    out[o] = r;
    out[o + 2] = b;
    out[o + 3] = a;

    if (protect[i] || strength <= 0 || a >= 255 || a === 0) {
      out[o + 1] = g;
      continue;
    }
    const neutral = (r + b) * 0.5;
    if (g > neutral) {
      const edgeWeight = 1 - a / 255;
      const s = clamp(strength * edgeWeight, 0, 1);
      out[o + 1] = g * (1 - s) + neutral * s;
    } else {
      out[o + 1] = g;
    }
  }
  return out;
}

/** 保护区域强制恢复为不透明，并且不参与溢色抑制，防止绿色前景被误删 */
export function applyProtection(
  alpha: Uint8ClampedArray,
  ambiguity: Uint8Array,
  protect: Uint8Array
): void {
  for (let i = 0; i < alpha.length; i++) {
    if (protect[i]) {
      alpha[i] = 255;
      ambiguity[i] = 1;
    }
  }
}

export function makeProtectionMask(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height);
}

/** 在保护遮罩上画一个圆形笔刷区域 */
export function paintProtection(
  protect: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number
): void {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(height - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        protect[y * width + x] = 1;
      }
    }
  }
}

export function clearProtection(protect: Uint8Array): void {
  protect.fill(0);
}

export function defaultParams(keyColor: KeyerParams['keyColor']): KeyerParams {
  return { keyColor, tolerance: 22, softness: 28, despill: 0.8, ambiguityFloor: 160 };
}
