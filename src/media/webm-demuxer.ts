import {
  EBML_ID,
  childElements,
  readBytes,
  readElement,
  readFloat,
  readInt,
  readString,
  readUint,
  readVint,
  type Element,
} from "./ebml";
import { finalizeVideo } from "./normalize";
import {
  InspectionError,
  type DemuxSample,
  type DemuxedVideo,
  type VideoSource,
} from "./types";

interface WebmTrack {
  number: number;
  trackType: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  defaultDurationNs: number;
  pixelWidth: number;
  pixelHeight: number;
  displayWidth: number;
  displayHeight: number;
  rotation: number;
}

interface ClusterState {
  timestamp: number;
  samples: DemuxSample[];
  timecodeScaleNs: number;
  track: WebmTrack;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function parseTrack(bytes: Uint8Array, entry: Element): WebmTrack {
  const track: WebmTrack = {
    number: 0,
    trackType: 0,
    codecId: "",
    defaultDurationNs: 0,
    pixelWidth: 0,
    pixelHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    rotation: 0,
  };

  for (const child of childElements(bytes, entry.dataStart, entry.end)) {
    switch (child.id) {
      case EBML_ID.trackNumber:
        track.number = readUint(bytes, child);
        break;
      case EBML_ID.trackType:
        track.trackType = readUint(bytes, child);
        break;
      case EBML_ID.codecId:
        track.codecId = readString(bytes, child);
        break;
      case EBML_ID.codecPrivate:
        track.codecPrivate = readBytes(bytes, child).slice();
        break;
      case EBML_ID.defaultDuration:
        track.defaultDurationNs = readUint(bytes, child);
        break;
      case EBML_ID.video:
        for (const video of childElements(bytes, child.dataStart, child.end)) {
          if (video.id === EBML_ID.pixelWidth) {
            track.pixelWidth = readUint(bytes, video);
          } else if (video.id === EBML_ID.pixelHeight) {
            track.pixelHeight = readUint(bytes, video);
          } else if (video.id === EBML_ID.displayWidth) {
            track.displayWidth = readUint(bytes, video);
          } else if (video.id === EBML_ID.displayHeight) {
            track.displayHeight = readUint(bytes, video);
          } else if (video.id === EBML_ID.projection) {
            track.rotation = readProjectionRoll(bytes, video);
          }
        }
        break;
      default:
        break;
    }
  }
  return track;
}

function readProjectionRoll(bytes: Uint8Array, projection: Element): number {
  for (const child of childElements(bytes, projection.dataStart, projection.end)) {
    if (child.id === EBML_ID.projectionPoseRoll) {
      return (readFloat(bytes, child) * 180) / Math.PI;
    }
  }
  return 0;
}

function codecInfo(track: WebmTrack): {
  codec: string;
  label: string;
  description?: Uint8Array;
} {
  const privateData = track.codecPrivate;
  switch (track.codecId) {
    case "V_VP8":
      return { codec: "vp8", label: "VP8" };
    case "V_VP9":
      return { codec: "vp09.00.10.08", label: "VP9" };
    case "V_AV1": {
      if (!privateData || privateData.length < 3) {
        return {
          codec: "av01.0.05M.08",
          label: "AV1",
          description: privateData,
        };
      }
      const profile = (privateData[1] >> 5) & 0x07;
      const level = privateData[1] & 0x1f;
      const tier = privateData[2] & 0x80 ? "H" : "M";
      const highBitDepth = Boolean(privateData[2] & 0x40);
      const twelveBit = Boolean(privateData[2] & 0x20);
      const depth = twelveBit ? 12 : highBitDepth ? 10 : 8;
      return {
        codec: `av01.${profile}.${String(level).padStart(2, "0")}${tier}.${String(depth).padStart(2, "0")}`,
        label: "AV1",
        description: privateData,
      };
    }
    case "V_MPEG4/ISO/AVC": {
      if (privateData && privateData.length >= 4) {
        return {
          codec: `avc1.${hexByte(privateData[1])}${hexByte(privateData[2])}${hexByte(privateData[3])}`,
          label: "H.264 / AVC",
          description: privateData,
        };
      }
      throw new InspectionError(
        "capability",
        "WebM 中的 H.264 轨道缺少 avcC CodecPrivate。",
        ["H.264 avcC 解码配置"],
      );
    }
    default:
      throw new InspectionError(
        "capability",
        `WebM 使用了当前工具尚未映射的 Codec ID：${track.codecId || "(空)"}`,
        [
          `WebM Codec ID “${track.codecId || "(空)"}” 的 WebCodecs 映射`,
          "支持范围：VP8、VP9、AV1、带 avcC 的 H.264",
        ],
      );
  }
}

function createBlockState(
  scaleNs: number,
  track: WebmTrack,
): ClusterState {
  return {
    timestamp: 0,
    samples: [],
    timecodeScaleNs: scaleNs,
    track,
  };
}

function parseBlock(
  bytes: Uint8Array,
  block: Element,
  state: ClusterState,
  options: {
    simple?: boolean;
    blockDurationTicks?: number;
    forceKey?: boolean;
  },
): void {
  const trackVint = readVint(bytes, block.dataStart, block.end);
  if (trackVint.value !== state.track.number) return;

  const timestampOffset = block.dataStart + trackVint.length;
  if (timestampOffset + 3 > block.end) {
    throw new InspectionError("demux", "WebM Block 头部不完整。");
  }
  const relative = readInt(bytes, {
    id: 0,
    headerStart: timestampOffset,
    dataStart: timestampOffset,
    end: timestampOffset + 2,
    declaredEnd: timestampOffset + 2,
    unknownSize: false,
  } as Element);
  const flags = bytes[timestampOffset + 2];
  const lacing = (flags >> 1) & 0x03;
  if (lacing !== 0) {
    throw new InspectionError(
      "demux",
      "WebM 视频 Block 使用了 lacing；当前检查器只接受逐帧 Block。",
    );
  }

  const absoluteTicks = state.timestamp + relative;
  const timestampUs = Math.max(
    0,
    Math.round((absoluteTicks * state.timecodeScaleNs) / 1_000),
  );
  const declaredDurationUs = options.blockDurationTicks
    ? Math.round(
        (options.blockDurationTicks * state.timecodeScaleNs) / 1_000,
      )
    : Math.round(state.track.defaultDurationNs / 1_000);
  const key =
    options.forceKey ??
    (options.simple ? Boolean(flags & 0x80) : false);
  const visible =
    options.simple ? !(flags & 0x08) : true;

  state.samples.push({
    decodeIndex: state.samples.length,
    timestampUs,
    durationUs: declaredDurationUs,
    isKey: key,
    visible,
    data: bytes.subarray(timestampOffset + 3, block.end),
    rawTimestamp: absoluteTicks,
  });
}

function parseBlockGroup(
  bytes: Uint8Array,
  group: Element,
  state: ClusterState,
): void {
  let block: Element | undefined;
  let key = true;
  let blockDurationTicks = 0;
  for (const child of childElements(bytes, group.dataStart, group.end)) {
    if (child.id === EBML_ID.block) block = child;
    if (child.id === EBML_ID.referenceBlock) key = false;
    if (child.id === EBML_ID.blockDuration) {
      blockDurationTicks = readUint(bytes, child);
    }
  }
  if (block) parseBlock(bytes, block, state, { forceKey: key, blockDurationTicks });
}

function parseCluster(
  bytes: Uint8Array,
  cluster: Element,
  scaleNs: number,
  track: WebmTrack,
  destination: DemuxSample[],
): void {
  if (cluster.unknownSize) {
    throw new InspectionError(
      "demux",
      "WebM 使用了未知长度的 Cluster；当前解复用器需要明确的 Cluster 边界。",
    );
  }

  const state = createBlockState(scaleNs, track);
  for (const child of childElements(bytes, cluster.dataStart, cluster.end)) {
    if (child.id === EBML_ID.timestamp) {
      state.timestamp = readUint(bytes, child);
    } else if (child.id === EBML_ID.simpleBlock) {
      parseBlock(bytes, child, state, { simple: true });
    } else if (child.id === EBML_ID.blockGroup) {
      parseBlockGroup(bytes, child, state);
    }
  }
  destination.push(...state.samples);
}

export async function demuxWebm(file: Blob): Promise<VideoSource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const root = readElement(bytes, 0, bytes.length);
  if (root.id !== EBML_ID.ebml) {
    throw new InspectionError("demux", "文件缺少 EBML 头。");
  }

  let segment: Element | undefined;
  for (const element of childElements(bytes, root.end, bytes.length)) {
    if (element.id === EBML_ID.segment) {
      segment = element;
      break;
    }
  }
  if (!segment) throw new InspectionError("demux", "WebM 缺少 Segment。");

  let timecodeScaleNs = 1_000_000;
  let durationUs = 0;
  let videoTrack: WebmTrack | undefined;
  const tracks: WebmTrack[] = [];
  const clusters: Element[] = [];

  for (const element of childElements(bytes, segment.dataStart, segment.end)) {
    if (element.id === EBML_ID.info) {
      for (const child of childElements(bytes, element.dataStart, element.end)) {
        if (child.id === EBML_ID.timecodeScale) {
          timecodeScaleNs = readUint(bytes, child);
        } else if (child.id === EBML_ID.duration) {
          durationUs = Math.round(readFloat(bytes, child) * 1_000_000);
        }
      }
    } else if (element.id === EBML_ID.tracks) {
      for (const child of childElements(bytes, element.dataStart, element.end)) {
        if (child.id === EBML_ID.trackEntry) {
          tracks.push(parseTrack(bytes, child));
        }
      }
    } else if (element.id === EBML_ID.cluster) {
      clusters.push(element);
    }
  }

  videoTrack = tracks.find(
    (candidate) => candidate.trackType === 1 && candidate.number > 0,
  );
  if (!videoTrack) {
    throw new InspectionError(
      "demux",
      "WebM 中没有视频轨道；当前工具只检查视频帧。",
    );
  }
  if (videoTrack.pixelWidth <= 0 || videoTrack.pixelHeight <= 0) {
    throw new InspectionError("demux", "WebM 视频轨道缺少像素尺寸。");
  }

  const info = codecInfo(videoTrack);
  const samples: DemuxSample[] = [];
  for (const cluster of clusters) {
    parseCluster(
      bytes,
      cluster,
      timecodeScaleNs,
      videoTrack,
      samples,
    );
  }

  const demuxed: DemuxedVideo = {
    container: "webm",
    codec: info.codec,
    codecLabel: info.label,
    description: info.description,
    codedWidth: videoTrack.displayWidth || videoTrack.pixelWidth,
    codedHeight: videoTrack.displayHeight || videoTrack.pixelHeight,
    rotation: videoTrack.rotation,
    timescale: 1_000_000_000,
    durationUs,
    samples,
  };
  return finalizeVideo(demuxed);
}
