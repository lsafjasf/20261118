import type { KeyerParams } from '../types';
import { clamp, keyDistance } from './color';

/**
 * 过渡带标定指数。色度键距离在低覆盖度段被混合过程压缩
 * （距离 ~ alpha 的上凸函数），用 <1 的指数把线性归一化
 * 距离重新展开，使软遮罩更接近真实线性覆盖度。
 */
const TRANSITION_GAMMA = 0.6;

/**
 * 逐像素计算到背景色的色度距离，并按容差/软边宽度生成软遮罩。
 * 距离 <= tolerance 全透明；tolerance..tolerance+softness 之间 smoothstep 过渡。
 */
export function computeAlpha(
  image: Uint8ClampedArray,
  params: KeyerParams
): { alpha: Uint8ClampedArray; distance: Float32Array } {
  const n = image.length / 4;
  const alpha = new Uint8ClampedArray(n);
  const distance = new Float32Array(n);
  const { tolerance, softness, keyColor } = params;

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d = keyDistance(image[o], image[o + 1], image[o + 2], keyColor);
    distance[i] = d;
    let a: number;
    if (d <= tolerance) {
      a = 0;
    } else if (softness <= 0) {
      a = d > tolerance ? 255 : 0;
    } else if (d >= tolerance + softness) {
      a = 255;
    } else {
      const t = clamp((d - tolerance) / softness, 0, 1);
      a = t ** TRANSITION_GAMMA * 255;
    }
    alpha[i] = a;
  }
  return { alpha, distance };
}

/**
 * 歧义检测：近背景色像素若无法通过同类像素连通到画面边缘，
 * 说明它被前景包围（前景自身就是绿色），不能直接删成透明。
 * 返回 0/1 的歧义标记数组。
 */
export function detectAmbiguity(
  distance: Float32Array,
  width: number,
  height: number,
  tolerance: number
): Uint8Array {
  const n = width * height;
  const connected = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;

  const push = (idx: number): void => {
    if (!connected[idx] && distance[idx] <= tolerance) {
      connected[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (idx >= width) push(idx - width);
    if (idx < n - width) push(idx + width);
  }

  const ambiguity = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (distance[i] <= tolerance && !connected[i]) {
      ambiguity[i] = 1;
    }
  }
  return ambiguity;
}
