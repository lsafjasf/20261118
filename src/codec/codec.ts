import { Muxer, ArrayBufferTarget } from 'webm-muxer';

export interface EncodeOptions {
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  /** 全部编码为关键帧，方便逐帧解码抽查边缘 */
  allKeyFrames?: boolean;
  signal?: AbortSignal;
  onProgress?: (frameIndex: number, frameCount: number) => void;
}

export interface EncodedVideo {
  bytes: Uint8Array;
  codec: string;
  chunks: EncodedVideoChunk[];
  width: number;
  height: number;
  fps: number;
}

export function isWebCodecsSupported(): boolean {
  return (
    typeof globalThis.VideoEncoder !== 'undefined' &&
    typeof globalThis.VideoDecoder !== 'undefined' &&
    typeof globalThis.VideoFrame !== 'undefined'
  );
}

async function pickSupportedCodec(): Promise<string> {
  const candidates = ['vp09.00.10.08', 'vp8'];
  for (const codec of candidates) {
    const support = await VideoEncoder.isConfigSupported({
      codec,
      width: 640,
      height: 360,
      bitrate: 2_000_000
    });
    if (support.supported) return codec;
  }
  throw new Error('当前浏览器不支持 VP9/VP8 硬件编码');
}

/** 用 VideoEncoder 编码帧序列并封装为 WebM */
export async function encodeVideo(
  frames: Uint8ClampedArray[],
  opts: EncodeOptions
): Promise<EncodedVideo> {
  if (!isWebCodecsSupported()) {
    throw new Error('当前环境不支持 WebCodecs，请使用最新版 Chrome/Edge');
  }
  const codec = await pickSupportedCodec();
  const { width, height, fps } = opts;
  const bitrate = opts.bitrate ?? 4_000_000;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: codec === 'vp8' ? 'V_VP8' : 'V_VP9', width, height, frameRate: fps }
  });

  const chunks: EncodedVideoChunk[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      chunks.push(chunk);
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      throw err;
    }
  });

  encoder.configure({ codec, width, height, bitrate, framerate: fps });

  for (let t = 0; t < frames.length; t++) {
    if (opts.signal?.aborted) {
      encoder.close();
      throw new DOMException('编码已取消', 'AbortError');
    }
    const data = new Uint8ClampedArray(frames[t]);
    const vf = new VideoFrame(data, {
      format: 'RGBA',
      codedWidth: width,
      codedHeight: height,
      timestamp: Math.round((t / fps) * 1e6)
    });
    encoder.encode(vf, { keyFrame: opts.allKeyFrames ?? true });
    vf.close();
    if (encoder.encodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 0));
    }
    opts.onProgress?.(t + 1, frames.length);
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  const bytes = new Uint8Array(muxer.target.buffer);
  return { bytes, codec, chunks, width, height, fps };
}

export interface DecodedFrame {
  frame: VideoFrame;
  rgba: Uint8ClampedArray;
  timestamp: number;
  width: number;
  height: number;
}

/** 直接把编码产生的 chunk 喂回 VideoDecoder，绕开容器解封装做抽查 */
export async function decodeChunks(video: EncodedVideo): Promise<DecodedFrame[]> {
  if (!isWebCodecsSupported()) {
    throw new Error('当前环境不支持 WebCodecs');
  }
  const decoded: DecodedFrame[] = [];
  const decoder = new VideoDecoder({
    output: (frame) => {
      const rect =
        frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
      const w = rect.width;
      const h = rect.height;
      const rgba = frameToRgba(frame, w, h);
      decoded.push({
        frame,
        rgba,
        timestamp: frame.timestamp,
        width: w,
        height: h
      });
    },
    error: (err) => {
      throw err;
    }
  });
  decoder.configure({ codec: video.codec, codedWidth: video.width, codedHeight: video.height });

  for (const chunk of video.chunks) {
    decoder.decode(chunk);
    if (decoder.decodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  await decoder.flush();
  decoder.close();
  decoded.sort((a, b) => a.timestamp - b.timestamp);
  return decoded;
}

/** 解码器输出通常是 I420，借助 OffscreenCanvas/Canvas 统一转回 RGBA */
function frameToRgba(frame: VideoFrame, targetW: number, targetH: number): Uint8ClampedArray {
  const w = targetW;
  const h = targetH;
  const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    return new Uint8ClampedArray(data);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, w, h).data);
}
