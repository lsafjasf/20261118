import type { Frame, KeyerResult, RGB } from '../types';
import { compositeOverBackground, type BackgroundMode } from '../keying/composite';

export function putFrame(
  ctx: CanvasRenderingContext2D,
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): void {
  const imageData = new ImageData(
    new Uint8ClampedArray(rgba) as Uint8ClampedArray<ArrayBuffer>,
    width,
    height
  );
  ctx.putImageData(imageData, 0, 0);
}

/** 灰度遮罩 + 黄色歧义区叠加 */
export function renderMatte(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  result: KeyerResult,
  protect: Uint8Array
): void {
  const n = frame.width * frame.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const a = result.alpha[i];
    out[o] = a;
    out[o + 1] = a;
    out[o + 2] = a;
    out[o + 3] = 255;
    if (protect[i]) {
      // 已被用户保护：白色不透明，带一点蓝色调区别于普通前景
      out[o] = 180;
      out[o + 1] = 210;
      out[o + 2] = 255;
    } else if (result.ambiguity[i]) {
      out[o] = 245;
      out[o + 1] = 165;
      out[o + 2] = 36;
    }
  }
  putFrame(ctx, out, frame.width, frame.height);
}

/** 原帧上叠加采样框/保护区域/歧义提示 */
export function renderOriginal(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  result: KeyerResult,
  protect: Uint8Array,
  sampleRect: { x0: number; y0: number; x1: number; y1: number } | null
): void {
  const n = frame.width * frame.height;
  const out = new Uint8ClampedArray(frame.image);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (protect[i]) {
      out[o] = Math.min(255, out[o] + 90);
      out[o + 2] = Math.min(255, out[o + 2] + 60);
    } else if (result.ambiguity[i]) {
      out[o] = 245;
      out[o + 1] = 165;
      out[o + 2] = 36;
    }
  }
  putFrame(ctx, out, frame.width, frame.height);
 if (sampleRect) {
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.min(sampleRect.x0, sampleRect.x1),
      Math.min(sampleRect.y0, sampleRect.y1),
      Math.abs(sampleRect.x1 - sampleRect.x0),
      Math.abs(sampleRect.y1 - sampleRect.y0)
    );
  }
}

export function renderComposite(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  result: KeyerResult,
  mode: BackgroundMode,
  solid: RGB
): void {
  const rgba = compositeOverBackground(frame, result.despilled, mode, solid);
  putFrame(ctx, rgba, frame.width, frame.height);
}
