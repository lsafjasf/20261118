import type { DecoderConfigDesc, EncodedChunkInput } from './types.js';

/** 平台帧的最小抽象：真实环境是 VideoFrame，测试环境是 MockVideoFrame。 */
export interface FrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  close(): void;
}

/** 平台解码器句柄：真实环境包装 VideoDecoder，测试环境是 MockVideoDecoder。 */
export interface DecoderHandle {
  readonly state: 'unconfigured' | 'configured' | 'closed';
  /** 可能抛错（不支持的参数等），调用方负责捕获并重建。 */
  configure(config: DecoderConfigDesc): void;
  decode(chunk: EncodedChunkInput): void;
  /** 排空：resolve 时保证所有已提交块的输出帧都已投递。 */
  flush(): Promise<void>;
  /** 中止并丢弃队列，之后需要关键帧才能继续。 */
  reset(): void;
  close(): void;
}

export interface DecoderCallbacks {
  output(frame: FrameLike): void;
  error(error: unknown): void;
}

/**
 * 解码环境抽象。浏览器里由 WebCodecs 实现（见 web/webcodecs-env.ts），
 * 测试里由 mock 实现（见 test/mock-env.ts）。
 */
export interface DecoderEnvironment {
  isConfigSupported(config: DecoderConfigDesc): Promise<{ supported: boolean; reason?: string }>;
  createDecoder(callbacks: DecoderCallbacks): DecoderHandle;
}
