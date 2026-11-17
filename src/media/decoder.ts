import { decoderConfig } from "./capabilities";
import { decodeStartFor } from "./normalize";
import {
  InspectionError,
  type DemuxSample,
  type FrameSample,
  type VideoSource,
} from "./types";

export interface DecodeResult {
  frame: VideoFrame;
  target: FrameSample;
  start: DemuxSample;
  decodedChunks: number;
  outputTimestampUs: number;
}

export async function decodeFrameAt(
  source: VideoSource,
  target: FrameSample,
): Promise<DecodeResult> {
  const start = decodeStartFor(source, target);
  let targetFrame: VideoFrame | undefined;
  let callbackError: Error | undefined;
  let outputTimestampUs = 0;

  const decoder = new VideoDecoder({
    output(frame) {
      if (frame.timestamp === target.timestampUs && !targetFrame) {
        targetFrame = frame;
        outputTimestampUs = frame.timestamp;
      } else {
        frame.close();
      }
    },
    error(error) {
      callbackError = error;
    },
  });

  try {
    decoder.configure(decoderConfig(source));
    let decodedChunks = 0;
    for (
      let index = start.decodeIndex;
      index <= target.decodeIndex;
      index += 1
    ) {
      const sample = source.samples[index];
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.isKey ? "key" : "delta",
          timestamp: sample.timestampUs,
          duration: sample.durationUs || undefined,
          data: sample.data,
        }),
      );
      decodedChunks += 1;
    }
    await decoder.flush();
    if (callbackError) throw callbackError;
    if (!targetFrame) {
      throw new InspectionError(
        "decode",
        `解码器未输出目标帧 #${target.presentationIndex + 1}（PTS ${target.timestampUs} µs）。`,
        ["目标 PTS 对应的 VideoFrame 输出"],
      );
    }
    return {
      frame: targetFrame,
      target,
      start,
      decodedChunks,
      outputTimestampUs,
    };
  } catch (error) {
    targetFrame?.close();
    targetFrame = undefined;
    if (error instanceof InspectionError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (callbackError) {
      throw new InspectionError(
        "decode",
        `WebCodecs 解码 ${source.codec} 失败：${callbackError.message}`,
        [`${source.codec} 解码能力或码流兼容性（${detail}）`],
      );
    }
    throw new InspectionError(
      "decode",
      `WebCodecs 解码 ${source.codec} 失败：${detail}`,
      [`${source.codec} 解码能力`],
    );
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }
}
