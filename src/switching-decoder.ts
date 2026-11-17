import type { DecoderEnvironment, DecoderHandle, FrameLike } from './platform.js';
import { FrameTracker } from './frame-tracker.js';
import type {
  DecoderConfigDesc,
  FrameMeta,
  Segment,
  SegmentError,
  SegmentReport,
} from './types.js';

export interface SwitchingDecoderOptions {
  env: DecoderEnvironment;
  /** auto：优先在旧句柄上重配，失败则关闭重建；recreate：一律重建。 */
  strategy?: 'auto' | 'recreate';
  onFrame(frame: FrameLike, meta: FrameMeta): void;
  onError?(error: SegmentError): void;
}

function configKey(config: DecoderConfigDesc): string {
  const desc = config.description ? Array.from(config.description).join(',') : '';
  return `${config.codec}|${config.codedWidth}x${config.codedHeight}|${desc}`;
}

/**
 * 分段视频解码配置切换器。
 *
 * 不变量：
 * - 切换配置前必先排空（flush）旧解码器，旧代次帧全部投递后才应用新配置；
 * - 新配置应用后必须等到该段首个关键帧才开始 decode，前导非关键帧丢弃计数；
 * - 每个输出帧携带 {generation, segmentId, segmentIndex, width, height}；
 *   晚到的旧代次帧被立即 close，绝不进入新段输出；
 * - 不支持的配置不破坏现有解码器，用户换回合法配置后可继续解码。
 */
export class SegmentSwitchingDecoder {
  private readonly env: DecoderEnvironment;
  private readonly strategy: 'auto' | 'recreate';
  private readonly onFrameCb: (frame: FrameLike, meta: FrameMeta) => void;
  private readonly onErrorCb: (error: SegmentError) => void;
  readonly tracker = new FrameTracker();

  private decoder: DecoderHandle | null = null;
  private decoderId = 0;
  private readonly handleGenerations = new WeakMap<DecoderHandle, number>();
  private generation = 0;
  private currentKey: string | null = null;
  private currentSegmentIndex = -1;
  private currentSegmentId = '';
  private needsKeyframe = true;
  private decodeError: unknown = null;
  private segmentFrameCount = 0;
  private chain: Promise<void> = Promise.resolve();
  private staleFramesClosed = 0;
  private closed = false;

  constructor(options: SwitchingDecoderOptions) {
    this.env = options.env;
    this.strategy = options.strategy ?? 'auto';
    this.onFrameCb = options.onFrame;
    this.onErrorCb = options.onError ?? (() => {});
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get staleFramesDiscarded(): number {
    return this.staleFramesClosed;
  }

  /** 串行化分段处理，保证切换语义。 */
  pushSegment(segment: Segment, segmentIndex: number): Promise<SegmentReport> {
    const run = this.chain.then(() => this.processSegment(segment, segmentIndex));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private emitError(error: SegmentError): void {
    this.onErrorCb(error);
  }

  private makeDecoder(): DecoderHandle {
    const id = ++this.decoderId;
    const handle = this.env.createDecoder({
      output: (frame) => {
        // 代次守卫：旧解码器/旧代次的迟到帧直接释放，不进入输出。
        if (id !== this.decoderId || this.handleGenerations.get(handle) !== this.generation) {
          this.staleFramesClosed++;
          frame.close();
          return;
        }
        const tracked = this.tracker.acquire(frame);
        this.segmentFrameCount++;
        const meta: FrameMeta = {
          generation: this.generation,
          segmentId: this.currentSegmentId,
          segmentIndex: this.currentSegmentIndex,
          width: tracked.displayWidth,
          height: tracked.displayHeight,
          timestamp: tracked.timestamp,
        };
        this.onFrameCb(tracked, meta);
      },
      error: (err) => {
        this.decodeError = err ?? new Error('decoder error');
      },
    });
    return handle;
  }

  /** 应用新配置：先排空旧解码器，再按需重配或重建。 */
  private async applyConfig(
    segment: Segment,
    segmentIndex: number,
  ): Promise<SegmentError | null> {
    // 1. 排空旧解码器：flush resolve 后旧代次帧已全部投递。
    if (this.decoder && this.decoder.state === 'configured') {
      try {
        await this.decoder.flush();
      } catch {
        this.decoder.reset();
      }
    }

    // 2. 能力检查：不支持的配置不破坏现状，报告缺失能力。
    const support = await this.env.isConfigSupported(segment.config);
    if (!support.supported) {
      return {
        kind: 'unsupported-config',
        segmentId: segment.id,
        segmentIndex,
        message: `不支持的解码配置: ${segment.config.codec} ${segment.config.codedWidth}x${segment.config.codedHeight}`,
        capability: support.reason ?? segment.config.codec,
      };
    }

    // 3. 重配或重建；成功后句柄绑定到新一代次。
    const nextGeneration = this.generation + 1;
    if (this.strategy === 'recreate' || !this.decoder || this.decoder.state !== 'configured') {
      this.decoder?.close();
      this.decoder = null;
    }
    if (this.decoder) {
      try {
        this.decoder.configure(segment.config);
      } catch {
        // 重配失败 → 关闭重建。
        this.decoder.close();
        this.decoder = null;
      }
    }
    if (!this.decoder) {
      this.decoder = this.makeDecoder();
      try {
        this.decoder.configure(segment.config);
      } catch (cause) {
        return {
          kind: 'configure-failed',
          segmentId: segment.id,
          segmentIndex,
          message: `解码器配置失败: ${String(cause)}`,
          cause,
        };
      }
    }

    // 4. 配置生效：代次 +1，等待新段关键帧。
    this.handleGenerations.set(this.decoder, nextGeneration);
    this.generation = nextGeneration;
    this.currentKey = configKey(segment.config);
    this.needsKeyframe = true;
    this.decodeError = null;
    return null;
  }

  private async processSegment(segment: Segment, segmentIndex: number): Promise<SegmentReport> {
    if (this.closed) throw new Error('decoder is closed');
    const report: SegmentReport = {
      segmentId: segment.id,
      segmentIndex,
      generation: this.generation,
      decodedFrames: 0,
      droppedChunks: 0,
    };

    const key = configKey(segment.config);
    if (key !== this.currentKey) {
      const err = await this.applyConfig(segment, segmentIndex);
      if (err) {
        report.error = err;
        this.emitError(err);
        return report; // 旧解码器保持可用，等待用户换回合法配置。
      }
    }

    this.currentSegmentIndex = segmentIndex;
    this.currentSegmentId = segment.id;
    report.generation = this.generation;
    this.segmentFrameCount = 0;

    let sawKeyframe = false;
    for (const chunk of segment.chunks) {
      if (this.needsKeyframe && chunk.type !== 'key') {
        report.droppedChunks++; // 等待新段关键帧，丢弃前导非关键帧。
        continue;
      }
      if (chunk.type === 'key') {
        sawKeyframe = true;
        this.needsKeyframe = false;
      }
      this.decoder!.decode(chunk);
    }

    if (!sawKeyframe && this.needsKeyframe) {
      const err: SegmentError = {
        kind: 'missing-keyframe',
        segmentId: segment.id,
        segmentIndex,
        message: `分段 ${segment.id} 缺少起始关键帧，已丢弃 ${report.droppedChunks} 个块`,
      };
      report.error = err;
      this.emitError(err);
      return report;
    }

    // 段末排空，使该段输出帧计数确定。
    try {
      await this.decoder!.flush();
    } catch {
      /* 错误细节从 decodeError 取 */
    }
    if (this.decodeError !== null) {
      const cause = this.decodeError;
      this.decodeError = null;
      this.decoder!.reset(); // 中止后需等待下一个关键帧。
      this.needsKeyframe = true;
      const err: SegmentError = {
        kind: 'decode-error',
        segmentId: segment.id,
        segmentIndex,
        message: `分段 ${segment.id} 解码出错: ${String(cause)}`,
        cause,
      };
      report.error = err;
      this.emitError(err);
    }
    report.decodedFrames = this.segmentFrameCount;
    return report;
  }

  /** 排空并关闭，释放底层解码器。 */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    if (this.decoder && this.decoder.state === 'configured') {
      try {
        await this.decoder.flush();
      } catch {
        /* ignore */
      }
    }
    this.decoder?.close();
    this.decoder = null;
  }
}
