import type { FrameLike } from '../platform.js';
import type { FrameMeta, Segment, SegmentError, SegmentReport } from '../types.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export interface DecoderClientCallbacks {
  onFrame(frame: FrameLike, meta: FrameMeta): void;
  onError?(error: SegmentError): void;
}

interface WorkerLike {
  postMessage(message: WorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
  terminate(): void;
}

/** 主线程侧客户端：提交分段、接收带代次标记的帧。 */
export class DecoderWorkerClient {
  private readonly worker: WorkerLike;
  private readonly callbacks: DecoderClientCallbacks;
  private waiters: Array<(report: SegmentReport) => void> = [];
  private closeWaiter: ((outstanding: number) => void) | null = null;

  constructor(worker: WorkerLike, callbacks: DecoderClientCallbacks) {
    this.worker = worker;
    this.callbacks = callbacks;
    this.worker.onmessage = (ev) => this.handle(ev.data);
  }

  private handle(message: WorkerResponse): void {
    switch (message.type) {
      case 'frame':
        this.callbacks.onFrame(message.frame as FrameLike, message.meta);
        break;
      case 'error':
        this.callbacks.onError?.(message.error);
        break;
      case 'segment-done':
        this.waiters.shift()?.(message.report);
        break;
      case 'closed':
        this.closeWaiter?.(message.outstandingFrames);
        break;
    }
  }

  pushSegment(segment: Segment, segmentIndex: number): Promise<SegmentReport> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.worker.postMessage({ type: 'segment', segment, segmentIndex });
    });
  }

  close(): Promise<number> {
    return new Promise((resolve) => {
      this.closeWaiter = resolve;
      this.worker.postMessage({ type: 'close' });
    });
  }
}
