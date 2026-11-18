import type { Frame, KeyerParams, KeyerResult } from '../types';
import { applyProtection, despillImage } from './despill';
import { computeAlpha, detectAmbiguity } from './matte';

/**
 * 完整抠像管线：软遮罩 -> 歧义检测 -> 保护区域 -> 去溢色。
 * 所有计算在 TypedArray 上完成，可直接在 Node 中测试。
 */
export function runKeyer(frame: Frame, params: KeyerParams, protect?: Uint8Array): KeyerResult {
  const { alpha, distance } = computeAlpha(frame.image, params);
  const ambiguity = detectAmbiguity(distance, frame.width, frame.height, params.tolerance);

  // 歧义像素不能直接删空：保留一个 alpha 下限并标出，等用户用保护区域确认
  for (let i = 0; i < alpha.length; i++) {
    if (ambiguity[i] && alpha[i] < params.ambiguityFloor) {
      alpha[i] = params.ambiguityFloor;
    }
  }

  if (protect) {
    applyProtection(alpha, ambiguity, protect);
  }

  const safeProtect = protect ?? new Uint8Array(frame.width * frame.height);
  const despilled = despillImage(frame.image, alpha, params.despill, safeProtect);

  return { alpha, despilled, ambiguity, distance };
}
