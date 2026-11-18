import { describe, expect, it } from 'vitest';
import { runKeyer } from '../src/keying/keyer';
import { defaultParams } from '../src/keying/despill';
import { autoSample, sampleBackground } from '../src/keying/sampling';
import { FRAME_COUNT, generateFootage, SCREEN_KEY } from '../src/synthetic/scene';
import {
  measureAmbiguity,
  measureDecodeError,
  measureFrame,
  measureSequence,
  measureTemporalJitter
} from '../src/metrics/metrics';
import { chromaDistance } from '../src/keying/color';

const frames = generateFootage();

function keyAll(tolerance = 22, softness = 28, despill = 0.8, ambiguityFloor = 160) {
  const key = autoSample(frames[0]);
  return frames.map((f) =>
    runKeyer(f, { keyColor: key, tolerance, softness, despill, ambiguityFloor })
  );
}

describe('synthetic footage', () => {
  it('生成指定帧数与尺寸，且含半透明/细线/歧义像素', () => {
    expect(frames.length).toBe(FRAME_COUNT);
    expect(frames[0].image.length).toBe(480 * 270 * 4);
    const alphas = [...frames[0].truthAlpha];
    expect(alphas.some((a) => a > 0 && a < 255)).toBe(true);
    const ambig = frames.reduce((s, f) => s + sum(f.ambiguousTruth), 0);
    expect(ambig).toBeGreaterThan(100);
  });

  it('绿幕区域与前景红色小球色度距离差异明显', () => {
    const dGreen = chromaDistance(SCREEN_KEY.r, SCREEN_KEY.g, SCREEN_KEY.b, SCREEN_KEY);
    const dRed = chromaDistance(230, 95, 70, SCREEN_KEY);
    expect(dGreen).toBeCloseTo(0, 5);
    expect(dRed).toBeGreaterThan(60);
  });
});

describe('matte keying', () => {
  it('背景像素被键成透明，不透明前景保持不透明', () => {
    const results = keyAll();
    const f = frames[0];
    let bgCount = 0;
    let bgTransparent = 0;
    let fgCount = 0;
    let fgOpaque = 0;
    for (let i = 0; i < f.truthAlpha.length; i++) {
      if (f.truthAlpha[i] === 0) {
        bgCount++;
        if (results[0].alpha[i] === 0) bgTransparent++;
      } else if (f.truthAlpha[i] === 255 && !f.ambiguousTruth[i]) {
        fgCount++;
        if (results[0].alpha[i] === 255) fgOpaque++;
      }
    }
    expect(bgTransparent / bgCount).toBeGreaterThan(0.98);
    expect(fgOpaque / fgCount).toBeGreaterThan(0.97);
  });

  it('软遮罩存在中间值而非纯二值化', () => {
    const results = keyAll();
    const partial = [...results[0].alpha].filter((a) => a > 20 && a < 235);
    expect(partial.length).toBeGreaterThan(100);
  });

  it('容差调大时透明像素增加', () => {
    const narrow = keyAll(10, 28);
    const wide = keyAll(60, 28);
    const transparent = (a: Uint8ClampedArray) => [...a].filter((v) => v === 0).length;
    expect(transparent(wide[5].alpha)).toBeGreaterThan(transparent(narrow[5].alpha));
  });

  it('软边宽度影响过渡带像素数量', () => {
    const hard = keyAll(22, 1);
    const soft = keyAll(22, 60);
    const partial = (a: Uint8ClampedArray) => [...a].filter((v) => v > 10 && v < 245).length;
    expect(partial(soft[5].alpha)).toBeGreaterThan(partial(hard[5].alpha));
  });
});

describe('ambiguity detection', () => {
  it('绿色徽章被识别为歧义并保留，保护区域可恢复为完全不透明', () => {
    const results = keyAll();
    const { recall } = measureAmbiguity(frames, results);
    expect(recall).toBeGreaterThan(0.9);
    const f = frames[10];
    const r = results[10];
    let badgeKept = 0;
    let badgeTotal = 0;
    for (let i = 0; i < f.ambiguousTruth.length; i++) {
      if (f.ambiguousTruth[i]) {
        badgeTotal++;
        if (r.alpha[i] > 0) badgeKept++;
      }
    }
    expect(badgeKept / badgeTotal).toBeGreaterThan(0.9);

    const protect = new Uint8Array(f.width * f.height);
    for (let i = 0; i < protect.length; i++) if (f.ambiguousTruth[i]) protect[i] = 1;
    const protectedResult = runKeyer(
      f,
      { ...defaultParams(autoSample(f)), tolerance: 22, softness: 28 },
      protect
    );
    let restored = 0;
    for (let i = 0; i < protect.length; i++) {
      if (protect[i] && protectedResult.alpha[i] === 255) restored++;
    }
    expect(restored / badgeTotal).toBeGreaterThan(0.95);
  });
});

describe('despill', () => {
  it('强度为 0 时保持原色，强度增大时边缘绿色通道被压低', () => {
    const off = keyAll(22, 28, 0);
    const on = keyAll(22, 28, 1);
    let reduced = 0;
    let sampled = 0;
    for (let t = 0; t < frames.length; t += 4) {
      const f = frames[t];
      for (let i = 0; i < f.truthAlpha.length; i++) {
        const a = on[t].alpha[i];
        if (a > 0 && a < 255) {
          sampled++;
          if (on[t].despilled[i * 4 + 1] <= off[t].despilled[i * 4 + 1]) reduced++;
        }
      }
    }
    expect(reduced / sampled).toBeGreaterThan(0.8);
  });
});

describe('metrics', () => {
  it('边缘误差低于整体可控阈值，颜色偏移随去溢色保持在小范围', () => {
    const results = keyAll();
    const seq = measureSequence(frames, results);
    const avgEdge = avg(seq.perFrame.map((m) => m.edgeMAE));
    const avgColor = avg(seq.perFrame.map((m) => m.colorShift));
    expect(avgEdge).toBeLessThan(40);
    expect(avgColor).toBeLessThan(15);
  });

  it('静态背景区域帧间抖动接近零', () => {
    const results = keyAll();
    const jitter = measureTemporalJitter(frames, results.map((r) => r.alpha));
    expect(jitter).toBeLessThan(2);
  });

  it('逐帧指标对象字段完整', () => {
    const m = measureFrame(frames[0], keyAll()[0]);
    expect(Object.keys(m).sort()).toEqual(['alphaMAE', 'alphaRMSE', 'colorShift', 'edgeMAE']);
  });

  it('解码误差指标在完全一致输入时为 0', () => {
    const f = frames[0];
    const err = measureDecodeError(f.image, f.image, f.truthAlpha, f.width, f.height);
    expect(err.rgbMAE).toBe(0);
    expect(err.edgeMAE).toBe(0);
  });
});

describe('sampling', () => {
  it('自动采样结果接近真实绿幕色', () => {
    const key = autoSample(frames[0]);
    expect(Math.abs(key.g - SCREEN_KEY.g)).toBeLessThan(20);
    expect(key.g).toBeGreaterThan(key.r + 50);
  });

  it('矩形采样返回中位数颜色', () => {
    const key = sampleBackground(frames[0], 0, 0, 20, 20);
    expect(key.g).toBeGreaterThan(100);
  });
});

describe('default params', () => {
  it('包含全部四个可调参数', () => {
    const p = defaultParams({ r: 0, g: 170, b: 0 });
    expect(p).toMatchObject({ tolerance: 22, softness: 28, despill: 0.8, ambiguityFloor: 160 });
  });
});

function sum(arr: Uint8Array | Uint8ClampedArray): number {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
