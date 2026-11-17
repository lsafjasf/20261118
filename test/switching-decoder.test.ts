import { describe, expect, it, beforeEach } from 'vitest';
import { SegmentSwitchingDecoder } from '../src/switching-decoder.js';
import type { FrameLike } from '../src/platform.js';
import type { FrameMeta, SegmentError, SegmentReport } from '../src/types.js';
import {
  createMockEnvironment,
  frameStats,
  makeSegment,
  resetFrameStats,
} from './mock-env.js';

interface Collected {
  frames: Array<{ frame: FrameLike; meta: FrameMeta }>;
  errors: SegmentError[];
}

function setup(strategy: 'auto' | 'recreate' = 'auto') {
  const { env, handles } = createMockEnvironment();
  const collected: Collected = { frames: [], errors: [] };
  const decoder = new SegmentSwitchingDecoder({
    env,
    strategy,
    onFrame: (frame, meta) => collected.frames.push({ frame, meta }),
    onError: (err) => collected.errors.push(err),
  });
  return { decoder, collected, handles };
}

function closeAll(collected: Collected) {
  for (const { frame } of collected.frames) frame.close();
  collected.frames.length = 0;
}

beforeEach(() => resetFrameStats());

describe('正常切换', () => {
  it('两段不同分辨率，输出帧计数、尺寸、代次与分段标记正确', async () => {
    const { decoder, collected } = setup();
    const segA = makeSegment('A', 'avc1.64001f', 640, 360, 5);
    const segB = makeSegment('B', 'vp09.00.10.08', 1280, 720, 4, { startTimestamp: 1000 });

    const reportA = await decoder.pushSegment(segA, 0);
    const reportB = await decoder.pushSegment(segB, 1);

    expect(reportA.error).toBeUndefined();
    expect(reportB.error).toBeUndefined();
    expect(reportA.decodedFrames).toBe(5);
    expect(reportB.decodedFrames).toBe(4);
    expect(collected.frames).toHaveLength(9);

    const framesA = collected.frames.filter((f) => f.meta.segmentId === 'A');
    const framesB = collected.frames.filter((f) => f.meta.segmentId === 'B');
    expect(framesA).toHaveLength(5);
    expect(framesB).toHaveLength(4);

    // 代次：A 为第 1 代，B 为第 2 代；旧代次不得进入新段输出。
    expect(framesA.every((f) => f.meta.generation === 1)).toBe(true);
    expect(framesB.every((f) => f.meta.generation === 2)).toBe(true);
    expect(framesB.every((f) => f.meta.segmentIndex === 1)).toBe(true);

    // 尺寸标记与分段配置一致。
    expect(framesA.every((f) => f.meta.width === 640 && f.meta.height === 360)).toBe(true);
    expect(framesB.every((f) => f.meta.width === 1280 && f.meta.height === 720)).toBe(true);

    // auto 策略：重配复用同一句柄，未重建。
    expect(decoder.staleFramesDiscarded).toBe(0);
    closeAll(collected);
    await decoder.close();
    expect(decoder.tracker.outstanding).toBe(0);
    expect(frameStats.created).toBe(frameStats.closed);
  });

  it('recreate 策略同样保证代次隔离', async () => {
    const { decoder, collected, handles } = setup('recreate');
    await decoder.pushSegment(makeSegment('A', 'avc1.64001f', 640, 360, 3), 0);
    await decoder.pushSegment(makeSegment('B', 'avc1.64001f', 1920, 1080, 3), 1);
    expect(handles.length).toBe(2); // 重建了一个新解码器
    expect(collected.frames.filter((f) => f.meta.generation === 1)).toHaveLength(3);
    expect(collected.frames.filter((f) => f.meta.generation === 2)).toHaveLength(3);
    closeAll(collected);
    await decoder.close();
    expect(decoder.tracker.outstanding).toBe(0);
  });
});

describe('缺少起始关键帧', () => {
  it('整段无关键帧：全部丢弃并报告错误分段，补发关键帧后恢复', async () => {
    const { decoder, collected } = setup();
    await decoder.pushSegment(makeSegment('A', 'avc1.64001f', 640, 360, 3), 0);

    // B 段配置合法但没有任何关键帧。
    const segB = makeSegment('B', 'vp09.00.10.08', 1280, 720, 4, { noKeyframe: true });
    const reportB = await decoder.pushSegment(segB, 1);

    expect(reportB.error?.kind).toBe('missing-keyframe');
    expect(reportB.error?.segmentId).toBe('B');
    expect(reportB.droppedChunks).toBe(4);
    expect(reportB.decodedFrames).toBe(0);
    expect(collected.errors.at(-1)?.kind).toBe('missing-keyframe');
    // B 段没有任何帧进入输出。
    expect(collected.frames.filter((f) => f.meta.segmentId === 'B')).toHaveLength(0);

    // 用户补发带关键帧的同配置分段，继续解码（配置未变，代次不变）。
    const segB2 = makeSegment('B', 'vp09.00.10.08', 1280, 720, 4, { startTimestamp: 1000 });
    const reportB2 = await decoder.pushSegment(segB2, 2);
    expect(reportB2.error).toBeUndefined();
    expect(reportB2.decodedFrames).toBe(4);
    const framesB2 = collected.frames.filter((f) => f.meta.segmentIndex === 2);
    expect(framesB2).toHaveLength(4);
    expect(framesB2.every((f) => f.meta.width === 1280 && f.meta.height === 720)).toBe(true);

    closeAll(collected);
    await decoder.close();
    expect(decoder.tracker.outstanding).toBe(0);
  });
});

describe('不支持的配置', () => {
  it('报告缺失能力与错误分段，换回合法配置后继续解码', async () => {
    const { decoder, collected } = setup();
    await decoder.pushSegment(makeSegment('A', 'avc1.64001f', 640, 360, 3), 0);

    const segBad = makeSegment('BAD', 'xyz.unsupported', 3840, 2160, 3);
    const reportBad = await decoder.pushSegment(segBad, 1);
    expect(reportBad.error?.kind).toBe('unsupported-config');
    expect(reportBad.error?.segmentId).toBe('BAD');
    expect(reportBad.error?.capability).toContain('xyz.unsupported');
    expect(reportBad.decodedFrames).toBe(0);
    expect(collected.frames.filter((f) => f.meta.segmentId === 'BAD')).toHaveLength(0);

    // 用户换回合法配置：先回到 A 的配置（旧解码器未被破坏，直接复用）。
    const reportA2 = await decoder.pushSegment(makeSegment('A2', 'avc1.64001f', 640, 360, 2), 2);
    expect(reportA2.error).toBeUndefined();
    expect(reportA2.decodedFrames).toBe(2);
    expect(reportA2.generation).toBe(1); // 失败配置没有产生新代次

    // 再切到另一个合法的新配置，正常升代次。
    const reportC = await decoder.pushSegment(makeSegment('C', 'vp09.00.10.08', 1280, 720, 3), 3);
    expect(reportC.error).toBeUndefined();
    expect(reportC.decodedFrames).toBe(3);
    expect(reportC.generation).toBe(2);
    const framesC = collected.frames.filter((f) => f.meta.segmentId === 'C');
    expect(framesC.every((f) => f.meta.generation === 2 && f.meta.width === 1280)).toBe(true);

    closeAll(collected);
    await decoder.close();
    expect(decoder.tracker.outstanding).toBe(0);
  });
});

describe('重复切换压力', () => {
  it('两种配置往返切换 20 次，代次严格递增，未释放帧归零', async () => {
    const { decoder, collected } = setup();
    const reports: SegmentReport[] = [];
    for (let i = 0; i < 20; i++) {
      const even = i % 2 === 0;
      const seg = makeSegment(
        `S${i}`,
        even ? 'avc1.64001f' : 'vp09.00.10.08',
        even ? 640 : 1280,
        even ? 360 : 720,
        3,
        { startTimestamp: i * 1000 },
      );
      reports.push(await decoder.pushSegment(seg, i));
    }

    expect(reports.every((r) => r.error === undefined)).toBe(true);
    expect(reports.map((r) => r.decodedFrames)).toEqual(Array(20).fill(3));
    // 每次切换都应用新配置：代次 1..20 严格递增。
    expect(reports.map((r) => r.generation)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    expect(collected.frames).toHaveLength(60);
    for (const { meta } of collected.frames) {
      const even = meta.segmentIndex % 2 === 0;
      expect(meta.generation).toBe(meta.segmentIndex + 1);
      expect(meta.segmentId).toBe(`S${meta.segmentIndex}`);
      expect([meta.width, meta.height]).toEqual(even ? [640, 360] : [1280, 720]);
    }

    closeAll(collected);
    await decoder.close();
    expect(decoder.tracker.outstanding).toBe(0);
    expect(frameStats.created).toBe(frameStats.closed);
    expect(frameStats.created).toBe(60);
  });
});

describe('旧代次守卫', () => {
  it('旧解码器迟到投递的帧被立即释放，不进入新段输出', async () => {
    const { decoder, collected, handles } = setup('recreate');
    await decoder.pushSegment(makeSegment('A', 'avc1.64001f', 640, 360, 2), 0);
    await decoder.pushSegment(makeSegment('B', 'vp09.00.10.08', 1280, 720, 2), 1);
    expect(handles).toHaveLength(2);

    // 旧解码器（已关闭）迟到投递一帧旧尺寸帧。
    handles[0]!.lateOutput(640, 360, 9999);

    expect(decoder.staleFramesDiscarded).toBe(1);
    // 输出中只有 4 帧合法帧，迟到帧未进入新段输出。
    expect(collected.frames).toHaveLength(4);
    expect(collected.frames.every((f) => f.meta.generation === f.meta.segmentIndex + 1)).toBe(true);

    closeAll(collected);
    await decoder.close();
    expect(decoder.tracker.outstanding).toBe(0);
    // 5 帧创建（4 合法 + 1 迟到），5 帧全部释放。
    expect(frameStats.created).toBe(5);
    expect(frameStats.closed).toBe(5);
  });
});
