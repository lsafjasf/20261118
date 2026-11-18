import type { Frame, KeyerResult } from '../types';

export interface FrameMetrics {
  /** 遮罩整体平均绝对误差（alpha 0..255 空间） */
  alphaMAE: number;
  /** 遮罩均方根误差 */
  alphaRMSE: number;
  /** 边缘带内的平均绝对误差 */
  edgeMAE: number;
  /** 不透明前景的 RGB 平均颜色偏移 */
  colorShift: number;
}

export interface SequenceMetrics {
  perFrame: FrameMetrics[];
  /** 静态区域连续帧遮罩抖动（alpha 单位） */
  temporalJitter: number;
  /** 歧义检测召回率（真值歧义像素被标出的比例） */
  ambiguityRecall: number;
  /** 歧义检测精确率 */
  ambiguityPrecision: number;
}

/** 边缘带：参考遮罩 8..247 的像素及其 1 邻域 */
export function edgeBand(truth: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = width * height;
  const band = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (truth[i] > 8 && truth[i] < 247) {
      band[i] = 1;
      const x = i % width;
      if (x > 0) band[i - 1] = 1;
      if (x < width - 1) band[i + 1] = 1;
      if (i >= width) band[i - width] = 1;
      if (i < n - width) band[i + width] = 1;
    }
  }
  return band;
}

export function measureFrame(frame: Frame, result: KeyerResult): FrameMetrics {
  const n = frame.width * frame.height;
  const band = edgeBand(frame.truthAlpha, frame.width, frame.height);
  let sumAbs = 0;
  let sumSq = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let colorSum = 0;
  let colorCount = 0;

  for (let i = 0; i < n; i++) {
    const diff = Math.abs(result.alpha[i] - frame.truthAlpha[i]);
    sumAbs += diff;
    sumSq += diff * diff;
    if (band[i]) {
      edgeSum += diff;
      edgeCount++;
    }
    if (frame.truthAlpha[i] >= 250 && result.alpha[i] >= 250) {
      const o = i * 4;
      const dr = result.despilled[o] - frame.truthForeground[o];
      const dg = result.despilled[o + 1] - frame.truthForeground[o + 1];
      const db = result.despilled[o + 2] - frame.truthForeground[o + 2];
      colorSum += Math.hypot(dr, dg, db);
      colorCount++;
    }
  }

  return {
    alphaMAE: sumAbs / n,
    alphaRMSE: Math.sqrt(sumSq / n),
    edgeMAE: edgeCount ? edgeSum / edgeCount : 0,
    colorShift: colorCount ? colorSum / colorCount : 0
  };
}

/** 帧间抖动：参考遮罩未变化的像素上，估计 alpha 的相邻帧差 */
export function measureTemporalJitter(
  frames: Frame[],
  alphas: Uint8ClampedArray[]
): number {
  let sum = 0;
  let count = 0;
  for (let t = 1; t < frames.length; t++) {
    const n = frames[t].width * frames[t].height;
    for (let i = 0; i < n; i++) {
      if (frames[t].truthAlpha[i] === frames[t - 1].truthAlpha[i]) {
        sum += Math.abs(alphas[t][i] - alphas[t - 1][i]);
        count++;
      }
    }
  }
  return count ? sum / count : 0;
}

export function measureAmbiguity(
  frames: Frame[],
  results: KeyerResult[]
): { recall: number; precision: number } {
  let hit = 0;
  let truthCount = 0;
  let predCount = 0;
  for (let t = 0; t < frames.length; t++) {
    const n = frames[t].width * frames[t].height;
    for (let i = 0; i < n; i++) {
      truthCount += frames[t].ambiguousTruth[i];
      predCount += results[t].ambiguity[i];
      if (frames[t].ambiguousTruth[i] && results[t].ambiguity[i]) hit++;
    }
  }
  return {
    recall: truthCount ? hit / truthCount : 0,
    precision: predCount ? hit / predCount : 0
  };
}

export function measureSequence(frames: Frame[], results: KeyerResult[]): SequenceMetrics {
  const perFrame = frames.map((f, t) => measureFrame(f, results[t]));
  const temporalJitter = measureTemporalJitter(frames, results.map((r) => r.alpha));
  const { recall, precision } = measureAmbiguity(frames, results);
  return { perFrame, temporalJitter, ambiguityRecall: recall, ambiguityPrecision: precision };
}

/** 解码抽查：编码前与解码后的像素 MAE，以及边缘带 MAE */
export function measureDecodeError(
  encoded: Uint8ClampedArray,
  decoded: Uint8ClampedArray,
  truthAlpha: Uint8ClampedArray,
  width: number,
  height: number
): { rgbMAE: number; edgeMAE: number } {
  const n = width * height;
  const band = edgeBand(truthAlpha, width, height);
  let sum = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const d =
      (Math.abs(encoded[o] - decoded[o]) +
        Math.abs(encoded[o + 1] - decoded[o + 1]) +
        Math.abs(encoded[o + 2] - decoded[o + 2])) /
      3;
    sum += d;
    if (band[i]) {
      edgeSum += d;
      edgeCount++;
    }
  }
  return { rgbMAE: sum / n, edgeMAE: edgeCount ? edgeSum / edgeCount : 0 };
}
