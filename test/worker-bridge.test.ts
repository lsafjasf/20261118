import { describe, expect, it, beforeEach } from 'vitest';
import { DecoderWorkerClient } from '../src/worker/client.js';
import { createWorkerHandler } from '../src/worker/handler.js';
import type { WorkerRequest, WorkerResponse } from '../src/worker/protocol.js';
import type { FrameLike } from '../src/platform.js';
import type { FrameMeta, SegmentError } from '../src/types.js';
import { createMockEnvironment, frameStats, makeSegment, resetFrameStats } from './mock-env.js';

/** 内存版 Worker：异步投递消息，模拟跨线程边界。 */
function createBridge() {
  const { env } = createMockEnvironment();
  let clientOnMessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  const handler = createWorkerHandler(env, {
    postMessage(message) {
      queueMicrotask(() => clientOnMessage?.({ data: message } as MessageEvent<WorkerResponse>));
    },
  });
  const workerLike = {
    postMessage(message: WorkerRequest) {
      queueMicrotask(() => void handler.dispatch(message));
    },
    get onmessage() {
      return clientOnMessage;
    },
    set onmessage(cb) {
      clientOnMessage = cb;
    },
    terminate() {},
  };
  return { workerLike, handler };
}

beforeEach(() => resetFrameStats());

describe('Worker 协议端到端', () => {
  it('帧经 postMessage 到达主线程并带完整标记，关闭后未释放帧为零', async () => {
    const { workerLike, handler } = createBridge();
    const frames: Array<{ frame: FrameLike; meta: FrameMeta }> = [];
    const errors: SegmentError[] = [];
    const client = new DecoderWorkerClient(workerLike, {
      onFrame: (frame, meta) => frames.push({ frame, meta }),
      onError: (err) => errors.push(err),
    });

    const reportA = await client.pushSegment(makeSegment('A', 'avc1.64001f', 640, 360, 4), 0);
    const reportBad = await client.pushSegment(makeSegment('X', 'xyz.nope', 800, 600, 2), 1);
    const reportB = await client.pushSegment(makeSegment('B', 'vp09.00.10.08', 1280, 720, 4), 2);

    expect(reportA.decodedFrames).toBe(4);
    expect(reportBad.error?.kind).toBe('unsupported-config');
    expect(errors.some((e) => e.segmentId === 'X')).toBe(true);
    expect(reportB.decodedFrames).toBe(4);

    expect(frames).toHaveLength(8);
    expect(frames.filter((f) => f.meta.segmentId === 'A').every((f) => f.meta.generation === 1)).toBe(true);
    expect(frames.filter((f) => f.meta.segmentId === 'B').every((f) => f.meta.generation === 2)).toBe(true);

    for (const { frame } of frames) frame.close();
    const outstanding = await client.close();
    expect(outstanding).toBe(0);
    expect(handler.decoder.tracker.outstanding).toBe(0);
    expect(frameStats.created).toBe(frameStats.closed);
  });

  it('经 Worker 边界重复切换 20 次，无泄漏', async () => {
    const { workerLike } = createBridge();
    const frames: FrameLike[] = [];
    const client = new DecoderWorkerClient(workerLike, {
      onFrame: (frame) => frames.push(frame),
    });
    for (let i = 0; i < 20; i++) {
      const even = i % 2 === 0;
      const report = await client.pushSegment(
        makeSegment(`S${i}`, even ? 'avc1.64001f' : 'vp09.00.10.08', even ? 320 : 640, even ? 180 : 360, 2),
        i,
      );
      expect(report.error).toBeUndefined();
      expect(report.decodedFrames).toBe(2);
    }
    expect(frames).toHaveLength(40);
    for (const frame of frames) frame.close();
    const outstanding = await client.close();
    expect(outstanding).toBe(0);
    expect(frameStats.created).toBe(frameStats.closed);
  });
});
