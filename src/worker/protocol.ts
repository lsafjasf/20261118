import type { FrameMeta, Segment, SegmentError, SegmentReport } from '../types.js';

/** 主线程 → Worker */
export type WorkerRequest =
  | { type: 'segment'; segment: Segment; segmentIndex: number }
  | { type: 'close' };

/** Worker → 主线程。frame 在真实 Worker 中以 VideoFrame 转移，由主线程负责 close。 */
export type WorkerResponse =
  | { type: 'frame'; meta: FrameMeta; frame: unknown }
  | { type: 'error'; error: SegmentError }
  | { type: 'segment-done'; report: SegmentReport }
  | { type: 'closed'; outstandingFrames: number };
