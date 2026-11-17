import type {
  DecoderCallbacks,
  DecoderEnvironment,
  DecoderHandle,
} from '../platform.js';
import type { DecoderConfigDesc, EncodedChunkInput } from '../types.js';

/** 用真实 WebCodecs VideoDecoder 实现的解码环境（浏览器 / 支持 WebCodecs 的 Worker）。 */
export function createWebCodecsEnvironment(): DecoderEnvironment {
  return {
    async isConfigSupported(config) {
      const videoConfig: VideoDecoderConfig = {
        codec: config.codec,
        codedWidth: config.codedWidth,
        codedHeight: config.codedHeight,
      };
      if (config.description) videoConfig.description = config.description;
      if (config.hardwareAcceleration) videoConfig.hardwareAcceleration = config.hardwareAcceleration;
      if (config.optimizeForLatency !== undefined) videoConfig.optimizeForLatency = config.optimizeForLatency;
      try {
        const result = await VideoDecoder.isConfigSupported(videoConfig);
        return { supported: result.supported === true };
      } catch (err) {
        return { supported: false, reason: String(err) };
      }
    },

    createDecoder(callbacks: DecoderCallbacks): DecoderHandle {
      const decoder = new VideoDecoder({
        output: (frame) => callbacks.output(frame),
        error: (err) => callbacks.error(err),
      });
      return {
        get state() {
          return decoder.state;
        },
        configure(config) {
          const videoConfig: VideoDecoderConfig = {
            codec: config.codec,
            codedWidth: config.codedWidth,
            codedHeight: config.codedHeight,
          };
          if (config.description) videoConfig.description = config.description;
          if (config.hardwareAcceleration) videoConfig.hardwareAcceleration = config.hardwareAcceleration;
          if (config.optimizeForLatency !== undefined) videoConfig.optimizeForLatency = config.optimizeForLatency;
          decoder.configure(videoConfig);
        },
        decode(chunk: EncodedChunkInput) {
          const init: EncodedVideoChunkInit = {
            type: chunk.type,
            timestamp: chunk.timestamp,
            data: chunk.data,
          };
          if (chunk.duration !== undefined) init.duration = chunk.duration;
          decoder.decode(new EncodedVideoChunk(init));
        },
        async flush() {
          await decoder.flush();
        },
        reset() {
          decoder.reset();
        },
        close() {
          if (decoder.state !== 'closed') decoder.close();
        },
      };
    },
  };
}
