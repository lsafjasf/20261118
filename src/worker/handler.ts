import { SegmentSwitchingDecoder } from '../switching-decoder.js';
import type { DecoderEnvironment } from '../platform.js';
import type { SegmentReport } from '../types.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export interface WorkerSink {
  postMessage(message: WorkerResponse, transfer?: unknown[]): void;
}

/**
 * Worker 侧消息处理：与传输层无关，浏览器 Worker 与测试中的
 * 内存桥共用同一份逻辑。
 */
export function createWorkerHandler(env: DecoderEnvironment, sink: WorkerSink) {
  const decoder = new SegmentSwitchingDecoder({
    env,
    strategy: 'auto',
    onFrame(frame, meta) {
      // 真实 Worker 中 VideoFrame 可转移；所有权随之移交给主线程。
      sink.postMessage({ type: 'frame', meta, frame }, [frame]);
    },
    onError(error) {
      sink.postMessage({ type: 'error', error });
    },
  });

  return {
    async dispatch(message: WorkerRequest): Promise<void> {
      if (message.type === 'segment') {
        const report = await decoder.pushSegment(message.segment, message.segmentIndex);
        sink.postMessage({ type: 'segment-done', report });
        return;
      }
      if (message.type === 'close') {
        await decoder.close();
        sink.postMessage({ type: 'closed', outstandingFrames: decoder.tracker.outstanding });
      }
    },
    decoder,
  };
}
