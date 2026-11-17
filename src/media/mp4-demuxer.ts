import {
  DataStream,
  createFile,
  type Box,
  type MP4BoxBuffer,
  type Movie,
  type Sample,
  type Track,
  type VisualSampleEntry,
} from "mp4box";
import { finalizeVideo, microseconds } from "./normalize";
import {
  InspectionError,
  type DemuxSample,
  type DemuxedVideo,
  type VideoSource,
} from "./types";

function labelForCodec(codec: string): string {
  if (/^avc[1-4]\./i.test(codec)) return "H.264 / AVC";
  if (/^hvc[1-2]\.|^hev[1-2]\./i.test(codec)) return "H.265 / HEVC";
  if (/^vp0?8/i.test(codec)) return "VP8";
  if (/^vp0?9/i.test(codec)) return "VP9";
  if (/^av01/i.test(codec)) return "AV1";
  return codec;
}

function matrixRotation(matrix: Track["matrix"]): number {
  if (!matrix || matrix.length < 5) return 0;
  const a = Number(matrix[0]) / 65_536;
  const b = Number(matrix[1]) / 65_536;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

function visualEntry(mp4: ReturnType<typeof createFile>, trackId: number) {
  const trak = mp4.moov?.traks?.find((candidate) => {
    const id = candidate.tkhd?.track_id;
    return id === trackId;
  });
  return trak?.mdia?.minf?.stbl?.stsd?.entries?.find(
    (entry) => entry.isVideo?.() ?? false,
  ) as VisualSampleEntry | undefined;
}

function readConfigBox(box: Box | undefined): Uint8Array | undefined {
  if (!box) return undefined;
  try {
    const stream = new DataStream(undefined, 0, 1);
    box.write(stream);
    const bytes = new Uint8Array(stream.buffer);
    return bytes.length > 8 ? bytes.slice(8) : undefined;
  } catch {
    return undefined;
  }
}

function avcDescription(entry: VisualSampleEntry): Uint8Array | undefined {
  const config = entry.avcC;
  if (!config) return readConfigBox(entry);

  const parts: Uint8Array[] = [];
  const header = new Uint8Array(6);
  header[0] = config.configurationVersion || 1;
  header[1] = config.AVCProfileIndication;
  header[2] = config.profile_compatibility;
  header[3] = config.AVCLevelIndication;
  header[4] = 0xfc | (config.lengthSizeMinusOne & 3);
  header[5] = 0xe0 | (config.nb_SPS_nalus & 31);
  parts.push(header);

  for (const sps of config.SPS) {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, sps.data.length);
    parts.push(length, sps.data);
  }

  const ppsHeader = new Uint8Array([0xe0 | (config.nb_PPS_nalus & 31)]);
  parts.push(ppsHeader);
  for (const pps of config.PPS) {
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, pps.data.length);
    parts.push(length, pps.data);
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function descriptionFor(entry: VisualSampleEntry): Uint8Array | undefined {
  if (entry.avcC) return avcDescription(entry);
  return (
    readConfigBox(entry.hvcC) ??
    readConfigBox(entry.av1C) ??
    readConfigBox(entry.vpcC) ??
    readConfigBox(entry)
  );
}

function sampleFromMp4(sample: Sample): DemuxSample {
  const timescale = sample.timescale || 1;
  if (!sample.data) {
    throw new InspectionError(
      "demux",
      `MP4 样本 #${sample.number} 没有负载数据。`,
    );
  }
  return {
    decodeIndex: sample.number - 1,
    timestampUs: microseconds(sample.cts, timescale),
    dtsUs: microseconds(sample.dts, timescale),
    durationUs: microseconds(sample.duration, timescale),
    isKey: sample.is_sync,
    visible: true,
    data: sample.data,
    rawTimestamp: sample.cts,
  };
}

function pickVideoTrack(info: Movie): Track {
  const track = info.videoTracks?.find((candidate) => candidate.type === "video");
  if (!track) {
    throw new InspectionError(
      "demux",
      "MP4 中没有视频轨道；当前工具只检查视频帧。",
    );
  }
  return track;
}

async function extractSamples(
  mp4: ReturnType<typeof createFile>,
  track: Track,
  info: Movie,
): Promise<{ samples: DemuxSample[]; codec: string; entry?: VisualSampleEntry }> {
  const entry = visualEntry(mp4, track.id);
  const codec = entry?.getCodec?.() || track.codec;
  const expected = track.nb_samples || 0;
  const samples: DemuxSample[] = [];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (samples.length === 0) {
        reject(new InspectionError("demux", "MP4 视频轨道没有提取到样本。"));
      } else {
        resolve();
      }
    };

    mp4.onError = (_module, message) => {
      if (!settled) {
        settled = true;
        reject(new InspectionError("demux", `MP4 解析失败：${message}`));
      }
    };
    mp4.onSamples = (_id, _user, batch) => {
      for (const sample of batch) samples.push(sampleFromMp4(sample));
      if (expected > 0 && samples.length >= expected) finish();
    };

    mp4.setExtractionOptions(track.id, null, {
      nbSamples: expected || 1_000_000,
    });
    mp4.start();

    window.setTimeout(finish, 100);
    void info;
  });

  return { samples, codec, entry };
}

export async function demuxMp4(file: Blob): Promise<VideoSource> {
  const buffer = await file.arrayBuffer();
  const mp4 = createFile();
  let info: Movie | undefined;
  let readyError: Error | undefined;

  const ready = new Promise<void>((resolve) => {
    mp4.onReady = (movie) => {
      info = movie;
      resolve();
    };
    mp4.onError = (module, message) => {
      readyError = new Error(`${module}: ${message}`);
    };
  });

  try {
    const input = buffer as MP4BoxBuffer;
    input.fileStart = 0;
    mp4.appendBuffer(input, true);
    mp4.flush();
    await Promise.race([
      ready,
      new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
    ]);
    if (readyError) throw readyError;
    if (!info) {
      throw new InspectionError("demux", "无法读取 MP4 的 moov 元数据。");
    }

    const track = pickVideoTrack(info);
    const { samples, codec, entry } = await extractSamples(mp4, track, info);
    if (!codec) {
      throw new InspectionError(
        "capability",
        "MP4 轨道未声明编解码器。",
        ["受支持的视频 Codec ID（如 avc1、vp09、av01）"],
      );
    }

    const codedWidth = entry?.width || track.video?.width || 0;
    const codedHeight = entry?.height || track.video?.height || 0;
    const demuxed: DemuxedVideo = {
      container: "mp4",
      codec,
      codecLabel: labelForCodec(codec),
      description: entry ? descriptionFor(entry) : undefined,
      codedWidth,
      codedHeight,
      rotation: matrixRotation(track.matrix),
      timescale: track.timescale,
      durationUs: microseconds(Math.max(track.duration, track.samples_duration), track.timescale),
      samples,
    };
    return finalizeVideo(demuxed);
  } catch (error) {
    if (error instanceof InspectionError) throw error;
    throw new InspectionError(
      "demux",
      `MP4 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
