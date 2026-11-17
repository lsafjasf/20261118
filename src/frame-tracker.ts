import type { FrameLike } from './platform.js';

/**
 * 帧泄漏追踪：所有进入输出的帧在此登记，close 时注销。
 * outstanding === 0 表示没有未释放帧。
 */
export class FrameTracker {
  private readonly live = new Set<FrameLike>();
  private closedTotal = 0;
  private wrapped = new WeakSet<FrameLike>();

  /** 登记一帧，并包装其 close 以便精确计数（幂等）。 */
  acquire<T extends FrameLike>(frame: T): T {
    if (this.wrapped.has(frame)) return frame;
    this.wrapped.add(frame);
    this.live.add(frame);
    const originalClose = frame.close.bind(frame);
    frame.close = () => {
      if (this.live.delete(frame)) {
        this.closedTotal++;
        originalClose();
      }
    };
    return frame;
  }

  get outstanding(): number {
    return this.live.size;
  }

  get closed(): number {
    return this.closedTotal;
  }
}
