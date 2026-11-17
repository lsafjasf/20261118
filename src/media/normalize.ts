import type {
  DemuxedVideo,
  DemuxSample,
  FrameSample,
  VideoSource,
} from "./types";
import { InspectionError } from "./types";

export function normalizeRotation(value: number): number {
  const rounded = Math.round(value / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

export function normalizeTimestamp(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1_000_000));
}

export function finalizeVideo(demuxed: DemuxedVideo): VideoSource {
  if (demuxed.samples.length === 0) {
    throw new InspectionError("demux", "容器中没有可解码的视频帧。");
  }

  const samples = demuxed.samples.map((sample, order) => ({
    ...sample,
    decodeIndex: order,
  }));

  const visible = [...samples]
    .filter((sample) => sample.visible)
    .sort(
      (a, b) =>
        a.timestampUs - b.timestampUs || a.decodeIndex - b.decodeIndex,
    );

  if (visible.length === 0) {
    throw new InspectionError("demux", "视频轨道中没有可显示帧。");
  }

  const frames: FrameSample[] = visible.map((sample, index) => {
    const next = visible[index + 1];
    const presentationDuration = next
      ? next.timestampUs - sample.timestampUs
      : 0;
    return {
      ...sample,
      durationUs: presentationDuration || sample.durationUs,
      presentationIndex: index,
      timestampSeconds: sample.timestampUs / 1_000_000,
    };
  });

  const lastFrame = frames.at(-1)!;
  if (lastFrame.durationUs <= 0) {
    lastFrame.durationUs =
      frames.length > 1 ? frames[frames.length - 2].durationUs : 33_333;
  }

  const durations = frames
    .map((frame) => frame.durationUs)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const minFrameDurationUs = durations.length ? Math.min(...durations) : 0;
  const maxFrameDurationUs = durations.length ? Math.max(...durations) : 0;
  const durationUs = Math.max(
    demuxed.durationUs,
    lastFrame.timestampUs + (maxFrameDurationUs || 33_333),
  );
  const averageFps =
    durationUs > 0 ? frames.length / (durationUs / 1_000_000) : 0;
  const isVfr =
    maxFrameDurationUs > 0 &&
    maxFrameDurationUs - minFrameDurationUs >
      Math.max(2_000, (maxFrameDurationUs * 0.08));

  const rotation = normalizeRotation(demuxed.rotation);
  const quarterTurn = rotation === 90 || rotation === 270;

  return {
    ...demuxed,
    samples,
    frames,
    durationUs,
    rotation,
    isVfr,
    minFrameDurationUs,
    maxFrameDurationUs,
    averageFps,
    displayWidth: quarterTurn ? demuxed.codedHeight : demuxed.codedWidth,
    displayHeight: quarterTurn ? demuxed.codedWidth : demuxed.codedHeight,
  };
}

export function frameAtOrBefore(source: VideoSource, timeUs: number): FrameSample {
  let low = 0;
  let high = source.frames.length - 1;
  let result = source.frames[0];

  while (low <= high) {
    const middle = (low + high) >> 1;
    const frame = source.frames[middle];
    if (frame.timestampUs <= timeUs) {
      result = frame;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

export function decodeStartFor(
  source: VideoSource,
  target: DemuxSample,
): DemuxSample {
  for (let index = target.decodeIndex; index >= 0; index -= 1) {
    const sample = source.samples[index];
    if (sample.isKey) return sample;
  }

  throw new InspectionError(
    "no-keyframe",
    `帧 #${target.decodeIndex + 1} 之前没有可用的关键帧，无法独立解码。`,
    ["目标时间之前的 IDR / sync sample"],
  );
}

export function microseconds(value: number, timescale: number): number {
  return Math.round((value / timescale) * 1_000_000);
}
