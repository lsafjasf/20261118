import type { Frame } from '../types';
import {
  circleCoverage,
  ellipseCoverage,
  lineCoverage,
  makeRng,
  noLayer,
  roundedRectCoverage,
  type LayerSample
} from './raster';

export const FOOTAGE_WIDTH = 480;
export const FOOTAGE_HEIGHT = 270;
export const FRAME_COUNT = 24;
export const FPS = 12;

export const SCREEN_KEY = { r: 18, g: 168, b: 52 } as const;

/**
 * 单帧场景定义。前景分四层：
 * 1. 细线（慢速摆动）   2. 半透明纱（飘动，coverage ~0.45）
 * 3. 快速移动小球      4. 蓝色主体 + 绿色徽章（自身接近背景色 -> 歧义）
 */
interface SceneElement {
  sample: (x: number, y: number, frameIndex: number) => LayerSample;
}

function thinLine(): SceneElement {
  return {
    sample(x, y, t) {
      const sway = Math.sin(t * 0.35) * 14;
      const ax = 96 + sway;
      const bx = 176 + sway * 0.6;
      const coverage = lineCoverage(x, y, ax, 40, bx, 230, 1.6);
      return coverage > 0 ? { coverage, color: [235, 205, 120] } : noLayer;
    }
  };
}

function gauze(): SceneElement {
  return {
    sample(x, y, t) {
      const cx = 210 + Math.sin(t * 0.5) * 10;
      const cy = 132 + Math.cos(t * 0.4) * 8;
      const c = ellipseCoverage(x, y, cx, cy, 62, 42);
      if (c <= 0) return noLayer;
      const weave = 0.85 + 0.15 * Math.sin(x * 0.9) * Math.cos(y * 0.9);
      return { coverage: Math.min(c, 1) * 0.45 * weave, color: [210, 225, 235] };
    }
  };
}

function fastBall(): SceneElement {
  return {
    sample(x, y, t) {
      const cx = 60 + t * 16.5;
      const cy = 70 + Math.sin(t * 1.1) * 18;
      const coverage = circleCoverage(x, y, cx, cy, 11);
      return coverage > 0 ? { coverage, color: [230, 95, 70] } : noLayer;
    }
  };
}

function bodyWithBadge(): SceneElement {
  return {
    sample(x, y, t) {
      const bx = 300 + Math.sin(t * 0.25) * 6;
      const by = 118 + Math.cos(t * 0.3) * 5;
      const body = roundedRectCoverage(x, y, bx - 55, by - 60, 110, 120, 18);
      if (body <= 0) return noLayer;
      const badgeDist = Math.hypot(x - (bx + 18), y - (by - 18));
      if (badgeDist <= 13.5) {
        // 徽章是绿色的：直色与绿幕接近，属于前景却会被色度键误伤
        return { coverage: body, color: [28, 148, 60], ambiguous: true };
      }
      return { coverage: body, color: [70, 110, 205] };
    }
  };
}

const ELEMENTS: SceneElement[] = [thinLine(), gauze(), fastBall(), bodyWithBadge()];

/** 生成全部测试帧，同时输出参考遮罩、前景真值与歧义标记 */
export function generateFootage(): Frame[] {
  const frames: Frame[] = [];
  const n = FOOTAGE_WIDTH * FOOTAGE_HEIGHT;

  for (let t = 0; t < FRAME_COUNT; t++) {
    const rng = makeRng(9173 + t * 131);
    const image = new Uint8ClampedArray(n * 4);
    const truthAlpha = new Uint8ClampedArray(n);
    const truthForeground = new Uint8ClampedArray(n * 4);
    const ambiguousTruth = new Uint8Array(n);

    for (let y = 0; y < FOOTAGE_HEIGHT; y++) {
      for (let x = 0; x < FOOTAGE_WIDTH; x++) {
        const i = y * FOOTAGE_WIDTH + x;
        const o = i * 4;

        // 非均匀绿幕：中心标准色、四角压暗，加确定性噪声模拟实拍
        const vignette =
          1 - 0.06 * ((x / FOOTAGE_WIDTH - 0.5) ** 2 + (y / FOOTAGE_HEIGHT - 0.5) ** 2) * 4;
        const noise = (rng() - 0.5) * 10;
        let bgR = SCREEN_KEY.r * vignette + noise * 0.4;
        let bgG = SCREEN_KEY.g * vignette + noise;
        let bgB = SCREEN_KEY.b * vignette + noise * 0.4;

        let fgR = 0;
        let fgG = 0;
        let fgB = 0;
        let totalA = 0;
        let isAmbiguous = 0;

        // 层从后往前 over 合成
        for (const el of ELEMENTS) {
          const s = el.sample(x, y, t);
          if (s.coverage <= 0) continue;
          const a = s.coverage * (1 - totalA);
          fgR = fgR * (1 - a) + s.color[0] * a;
          fgG = fgG * (1 - a) + s.color[1] * a;
          fgB = fgB * (1 - a) + s.color[2] * a;
          totalA += a;
          if (s.ambiguous && s.coverage > 0.5) isAmbiguous = 1;
        }

        const fNoise = (rng() - 0.5) * 6;
        fgR += fNoise;
        fgG += fNoise;
        fgB += fNoise;

        truthAlpha[i] = Math.round(Math.min(1, totalA) * 255);
        truthForeground[o] = Math.max(0, Math.min(255, fgR));
        truthForeground[o + 1] = Math.max(0, Math.min(255, fgG));
        truthForeground[o + 2] = Math.max(0, Math.min(255, fgB));
        truthForeground[o + 3] = truthAlpha[i];
        if (isAmbiguous && totalA > 0.5) ambiguousTruth[i] = 1;

        // 直色 over 绿幕 -> 最终合成帧
        const a = totalA;
        image[o] = fgR * a + bgR * (1 - a);
        image[o + 1] = fgG * a + bgG * (1 - a);
        image[o + 2] = fgB * a + bgB * (1 - a);
        image[o + 3] = 255;
      }
    }

    frames.push({
      width: FOOTAGE_WIDTH,
      height: FOOTAGE_HEIGHT,
      image,
      truthAlpha,
      truthForeground,
      ambiguousTruth
    });
  }
  return frames;
}
