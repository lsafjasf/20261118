import type {
  DecoderCallbacks,
  DecoderEnvironment,
  DecoderHandle,
  FrameLike,
} from '../src/platform.js';
import type { DecoderConfigDesc, EncodedChunkInput } from '../src/types.js';

/** 全局帧生命周期计数，用于泄漏断言。 */
export const frameStats = { created: 0, closed: 0 };

export function resetFrameStats(): void {
  frameStats.created = 0;
  frameStats.closed = 0;
}

export class MockVideoFrame implements FrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  private closedFlag = false;

  constructor(width: number, height: number, timestamp: number) {
    this.displayWidth = width;
    this.displayHeight = height;
    this.timestamp = timestamp;
    frameStats.created++;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  close(): void {
    if (this.closedFlag) throw new Error('double close');
    this.closedFlag = true;
    frameStats.closed++;
  }
}

/** 数据首字节为 0xff 的块模拟损坏码流，触发解码错误。 */
const CORRUPT = 0xff;

export function corruptChunk(timestamp: number): EncodedChunkInput {
  return { type: 'delta', timestamp, data: new Uint8Array([CORRUPT, 1, 2]) };
}

class MockDecoderHandle implements DecoderHandle {
  private callbacks: DecoderCallbacks;
  private config: DecoderConfigDesc | null = null;
  private queue: EncodedChunkInput[] = [];
  private needsKey = true;
  state: 'unconfigured' | 'configured' | 'closed' = 'unconfigured';
  configureCount = 0;

  constructor(callbacks: DecoderCallbacks) {
    this.callbacks = callbacks;
  }

  configure(config: DecoderConfigDesc): void {
    if (this.state === 'closed') throw new Error('configure on closed decoder');
    this.config = config;
    this.state = 'configured';
    this.needsKey = true;
    this.configureCount++;
  }

  decode(chunk: EncodedChunkInput): void {
    if (this.state !== 'configured') throw new Error('decode while not configured');
    this.queue.push(chunk);
  }

  async flush(): Promise<void> {
    if (this.state !== 'configured') return;
    const pending = this.queue;
    this.queue = [];
    await Promise.resolve(); // 模拟异步解码
    for (const chunk of pending) {
      if (this.needsKey && chunk.type !== 'key') {
        const err = new Error('key frame required after configure/flush');
        this.callbacks.error(err);
        throw err;
      }
      if (chunk.data[0] === CORRUPT) {
        const err = new Error('corrupt bitstream');
        this.callbacks.error(err);
        throw err;
      }
      this.needsKey = false;
      this.callbacks.output(
        new MockVideoFrame(this.config!.codedWidth, this.config!.codedHeight, chunk.timestamp),
      );
    }
  }

  /** 测试钩子：绕过队列直接投递一帧，模拟迟到输出。 */
  lateOutput(width: number, height: number, timestamp: number): void {
    this.callbacks.output(new MockVideoFrame(width, height, timestamp));
  }

  reset(): void {
    if (this.state === 'closed') return;
    this.queue = [];
    this.needsKey = true;
    this.state = 'configured';
  }

  close(): void {
    this.queue = [];
    this.state = 'closed';
  }
}

export interface MockEnvOptions {
  /** 返回 undefined 表示支持，否则为缺失能力说明。 */
  unsupportedReason?(config: DecoderConfigDesc): string | undefined;
}

export function createMockEnvironment(options: MockEnvOptions = {}): {
  env: DecoderEnvironment;
  handles: MockDecoderHandle[];
} {
  const handles: MockDecoderHandle[] = [];
  const env: DecoderEnvironment = {
    async isConfigSupported(config) {
      const reason =
        options.unsupportedReason?.(config) ??
        (/^(avc1|vp8|vp09|hev1|hvc1)/.test(config.codec) ? undefined : `缺少解码器能力: ${config.codec}`);
      return reason === undefined ? { supported: true } : { supported: false, reason };
    },
    createDecoder(callbacks) {
      const handle = new MockDecoderHandle(callbacks);
      handles.push(handle);
      return handle;
    },
  };
  return { env, handles };
}

/** 构造一段：1 个关键帧 + n-1 个 delta 帧。 */
export function makeSegment(
  id: string,
  codec: string,
  width: number,
  height: number,
  frameCount: number,
  opts: { noKeyframe?: boolean; startTimestamp?: number } = {},
) {
  const start = opts.startTimestamp ?? 0;
  const chunks: EncodedChunkInput[] = [];
  for (let i = 0; i < frameCount; i++) {
    chunks.push({
      type: i === 0 && !opts.noKeyframe ? 'key' : 'delta',
      timestamp: start + i * 33,
      data: new Uint8Array([1, 2, 3, i & 0x7f]),
    });
  }
  return { id, config: { codec, codedWidth: width, codedHeight: height }, chunks };
}
