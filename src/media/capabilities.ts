import type { VideoSource } from "./types";
import { InspectionError } from "./types";

export interface BrowserCapabilities {
  secureContext: boolean;
  videoDecoder: boolean;
  encodedVideoChunk: boolean;
  videoFrame: boolean;
  canvas2d: boolean;
  userAgent: string;
}

export function detectBrowserCapabilities(): BrowserCapabilities {
  return {
    secureContext: window.isSecureContext,
    videoDecoder: typeof VideoDecoder !== "undefined",
    encodedVideoChunk: typeof EncodedVideoChunk !== "undefined",
    videoFrame: typeof VideoFrame !== "undefined",
    canvas2d: Boolean(document.createElement("canvas").getContext("2d")),
    userAgent: navigator.userAgent,
  };
}

export function missingWebCodecsCapabilities(
  capabilities = detectBrowserCapabilities(),
): string[] {
  const missing: string[] = [];
  if (!capabilities.secureContext) {
    missing.push("安全上下文（请使用 HTTPS 或 localhost）");
  }
  if (!capabilities.videoDecoder) missing.push("WebCodecs VideoDecoder");
  if (!capabilities.encodedVideoChunk) {
    missing.push("WebCodecs EncodedVideoChunk");
  }
  if (!capabilities.videoFrame) missing.push("WebCodecs VideoFrame");
  if (!capabilities.canvas2d) missing.push("Canvas 2D 绘制能力");
  return missing;
}

export function decoderConfig(source: VideoSource): VideoDecoderConfig {
  const config: VideoDecoderConfig = {
    codec: source.codec,
    codedWidth: source.codedWidth || undefined,
    codedHeight: source.codedHeight || undefined,
    hardwareAcceleration: "no-preference",
    optimizeForLatency: true,
  };
  if (source.description?.length) {
    config.description = source.description;
  }
  return config;
}

export async function assertDecoderSupport(source: VideoSource): Promise<void> {
  const missing = missingWebCodecsCapabilities();
  if (missing.length > 0) {
    throw new InspectionError(
      "capability",
      "浏览器缺少 WebCodecs 所需能力。",
      missing,
    );
  }

  const config = decoderConfig(source);
  try {
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error("isConfigSupported 返回 supported: false");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InspectionError(
      "capability",
      `浏览器无法解码 ${source.codecLabel}（${source.codec}）：${detail}`,
      [
        `WebCodecs 视频解码器：${source.codec}`,
        source.description
          ? "容器 codec description 与浏览器解码器不兼容"
          : "容器缺少 WebCodecs 所需的 codec description",
      ],
    );
  }
}
