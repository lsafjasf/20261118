import { Reader, Mp4ParseError } from "./reader";
import { readBoxHeader, isContainer, BoxHeader, BoxIssue } from "./boxes";

export interface FileTypeInfo {
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: string[];
}

export interface VideoTrackInfo {
  kind: "video";
  trackId: number;
  codec: string;
  timescale: number;
  durationUnits: number;
  durationSeconds: number;
  width: number;
  height: number;
  rotationDegrees: number;
  matrix: number[];
  keyframeSamples: number[] | null; // stss；null 表示未声明（全部关键帧）
}

export interface AudioTrackInfo {
  kind: "audio";
  trackId: number;
  codec: string;
  timescale: number;
  durationUnits: number;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
}

export type TrackInfo = VideoTrackInfo | AudioTrackInfo;

export interface UnknownBoxInfo {
  offset: number;
  type: string;
  size: number;
}

export interface Mp4Metadata {
  fileSize: number;
  ftyp: FileTypeInfo | null;
  movieTimescale: number | null;
  movieDurationSeconds: number | null;
  tracks: TrackInfo[];
  unknownBoxes: UnknownBoxInfo[];
  issues: BoxIssue[];
}

interface TrackBuilder {
  trackId: number;
  width: number;
  height: number;
  matrix: number[];
  handler: string;
  timescale: number;
  durationUnits: number;
  codec: string;
  sampleRate: number;
  channels: number;
  keyframeSamples: number[] | null;
}

function newTrack(): TrackBuilder {
  return {
    trackId: 0,
    width: 0,
    height: 0,
    matrix: [],
    handler: "",
    timescale: 0,
    durationUnits: 0,
    codec: "unknown",
    sampleRate: 0,
    channels: 0,
    keyframeSamples: null,
  };
}

/** 由 tkhd 的 3x3 矩阵推算显示旋转角度（仅处理常见的 0/90/180/270）。 */
function rotationFromMatrix(m: number[]): number {
  if (m.length !== 9) return 0;
  const a = m[0];
  const b = m[1];
  const c = m[3];
  const d = m[4];
  if (a === 1 && b === 0 && c === 0 && d === 1) return 0;
  if (a === 0 && b === 1 && c === -1 && d === 0) return 90;
  if (a === -1 && b === 0 && c === 0 && d === -1) return 180;
  if (a === 0 && b === -1 && c === 1 && d === 0) return 270;
  return 0;
}

function parseFtyp(r: Reader, end: number): FileTypeInfo {
  const majorBrand = r.fourCC("ftyp major brand");
  const minorVersion = r.u32("ftyp minor version");
  const compatibleBrands: string[] = [];
  while (r.pos + 4 <= end) {
    compatibleBrands.push(r.fourCC("ftyp compatible brand"));
  }
  return { majorBrand, minorVersion, compatibleBrands };
}

function parseMvhd(r: Reader): { timescale: number; duration: number } {
  const version = r.u8("mvhd version");
  r.skip(3, "mvhd flags");
  if (version === 1) {
    r.skip(8, "mvhd creation_time");
    r.skip(8, "mvhd modification_time");
  } else {
    r.skip(4, "mvhd creation_time");
    r.skip(4, "mvhd modification_time");
  }
  const timescale = r.u32("mvhd timescale");
  const duration = version === 1 ? r.u64("mvhd duration") : r.u32("mvhd duration");
  return { timescale, duration };
}

function parseTkhd(r: Reader, t: TrackBuilder): void {
  const version = r.u8("tkhd version");
  r.skip(3, "tkhd flags");
  if (version === 1) {
    r.skip(8, "tkhd creation_time");
    r.skip(8, "tkhd modification_time");
    t.trackId = r.u32("tkhd track_id");
    r.skip(4, "tkhd reserved");
    r.skip(8, "tkhd duration");
  } else {
    r.skip(4, "tkhd creation_time");
    r.skip(4, "tkhd modification_time");
    t.trackId = r.u32("tkhd track_id");
    r.skip(4, "tkhd reserved");
    r.skip(4, "tkhd duration");
  }
  r.skip(8, "tkhd reserved[2]");
  r.skip(2, "tkhd layer");
  r.skip(2, "tkhd alternate_group");
  r.skip(2, "tkhd volume");
  r.skip(2, "tkhd reserved");
  const matrix: number[] = [];
  for (let i = 0; i < 9; i++) {
    matrix.push(r.i32("tkhd matrix") / 65536);
  }
  t.matrix = matrix;
  t.width = r.fixed16_16("tkhd width");
  t.height = r.fixed16_16("tkhd height");
}

function parseMdhd(r: Reader, t: TrackBuilder): void {
  const version = r.u8("mdhd version");
  r.skip(3, "mdhd flags");
  if (version === 1) {
    r.skip(8, "mdhd creation_time");
    r.skip(8, "mdhd modification_time");
    t.timescale = r.u32("mdhd timescale");
    t.durationUnits = r.u64("mdhd duration");
  } else {
    r.skip(4, "mdhd creation_time");
    r.skip(4, "mdhd modification_time");
    t.timescale = r.u32("mdhd timescale");
    t.durationUnits = r.u32("mdhd duration");
  }
}

function parseHdlr(r: Reader, t: TrackBuilder): void {
  r.skip(4, "hdlr version+flags");
  r.skip(4, "hdlr pre_defined");
  t.handler = r.fourCC("hdlr handler_type");
}

/** stsd：取第一个 sample entry 的编码类型及视频宽高 / 音频采样率与声道数。 */
function parseStsd(r: Reader, end: number, t: TrackBuilder, issues: BoxIssue[]): void {
  r.skip(4, "stsd version+flags");
  const entryCount = r.u32("stsd entry_count");
  if (entryCount === 0) return;
  const entryOffset = r.pos;
  const entrySize = r.u32("stsd entry size");
  const entryType = r.fourCC("stsd entry format");
  if (entrySize < 8 || entryOffset + entrySize > end) {
    issues.push({
      offset: entryOffset,
      message: `stsd sample entry '${entryType}' has corrupt size ${entrySize}; skipped`,
    });
    return;
  }
  t.codec = entryType;
  const entryEnd = entryOffset + entrySize;
  if (t.handler === "vide") {
    // VisualSampleEntry：8 字节保留/引用 + 16 字节 pre_defined + width/height
    if (entrySize >= 8 + 70) {
      r.skip(6 + 2 + 16, "VisualSampleEntry reserved");
      t.width = r.u16("video width");
      t.height = r.u16("video height");
    } else {
      issues.push({ offset: entryOffset, message: `video sample entry too small (${entrySize})` });
    }
  } else if (t.handler === "soun") {
    // AudioSampleEntry：8 字节保留/引用 + 8 字节保留 + channelcount/samplesize/.../samplerate
    if (entrySize >= 8 + 28) {
      r.skip(6 + 2 + 8, "AudioSampleEntry reserved");
      t.channels = r.u16("audio channelcount");
      r.skip(2, "audio samplesize");
      r.skip(2, "audio pre_defined");
      r.skip(2, "audio reserved");
      t.sampleRate = r.u32("audio samplerate") / 65536;
    } else {
      issues.push({ offset: entryOffset, message: `audio sample entry too small (${entrySize})` });
    }
  }
  r.pos = entryEnd;
}

function parseStss(r: Reader, t: TrackBuilder): void {
  r.skip(4, "stss version+flags");
  const count = r.u32("stss sample_count");
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(r.u32("stss sample_number"));
  }
  t.keyframeSamples = samples;
}

interface WalkContext {
  issues: BoxIssue[];
  unknownBoxes: UnknownBoxInfo[];
  meta: Mp4Metadata;
  track: TrackBuilder | null;
}

function walk(r: Reader, end: number, path: string, ctx: WalkContext): void {
  while (r.pos < end) {
    const h = readBoxHeader(r, end, ctx.issues);
    if (!h) return;
    const boxEnd = h.offset + h.size;
    const boxPath = path ? `${path}/${h.type}` : h.type;
    const r2 = new Reader(r.buf, h.contentOffset, boxEnd);
    try {
      dispatch(r2, boxEnd, boxPath, h, ctx);
    } catch (e) {
      if (e instanceof Mp4ParseError) {
        ctx.issues.push({ offset: e.offset, message: `in box '${boxPath}': ${e.message}` });
      } else {
        throw e;
      }
    }
    r.pos = boxEnd; // 无论解析是否中途出错，都跳到下一个兄弟 box
  }
}

function dispatch(
  r: Reader,
  end: number,
  path: string,
  h: BoxHeader,
  ctx: WalkContext
): void {
  const t = ctx.track;
  switch (path) {
    case "ftyp":
      ctx.meta.ftyp = parseFtyp(r, end);
      return;
    case "moov/mvhd": {
      const mv = parseMvhd(r);
      ctx.meta.movieTimescale = mv.timescale;
      ctx.meta.movieDurationSeconds = mv.timescale > 0 ? mv.duration / mv.timescale : null;
      return;
    }
    case "moov/trak":
      ctx.track = newTrack();
      walk(r, end, path, ctx);
      ctx.meta.tracks.push(finalizeTrack(ctx.track));
      ctx.track = null;
      return;
    case "moov/trak/tkhd":
      if (t) parseTkhd(r, t);
      return;
    case "moov/trak/mdia/mdhd":
      if (t) parseMdhd(r, t);
      return;
    case "moov/trak/mdia/hdlr":
      if (t) parseHdlr(r, t);
      return;
    case "moov/trak/mdia/minf/stbl/stsd":
      if (t) parseStsd(r, end, t, ctx.issues);
      return;
    case "moov/trak/mdia/minf/stbl/stss":
      if (t) parseStss(r, t);
      return;
    default:
      break;
  }
  if (isContainer(h.type)) {
    walk(r, end, path, ctx);
    return;
  }
  ctx.unknownBoxes.push({ offset: h.offset, type: h.type, size: h.size });
}

function finalizeTrack(t: TrackBuilder): TrackInfo {
  const durationSeconds = t.timescale > 0 ? t.durationUnits / t.timescale : 0;
  if (t.handler === "vide") {
    return {
      kind: "video",
      trackId: t.trackId,
      codec: t.codec,
      timescale: t.timescale,
      durationUnits: t.durationUnits,
      durationSeconds,
      width: t.width,
      height: t.height,
      rotationDegrees: rotationFromMatrix(t.matrix),
      matrix: t.matrix,
      keyframeSamples: t.keyframeSamples,
    };
  }
  return {
    kind: "audio",
    trackId: t.trackId,
    codec: t.codec,
    timescale: t.timescale,
    durationUnits: t.durationUnits,
    durationSeconds,
    sampleRate: t.sampleRate,
    channels: t.channels,
  };
}

/** 解析整个 MP4 文件缓冲区，返回元数据；所有问题（含截断）都带字节偏移。 */
export function parseMp4(buf: Buffer): Mp4Metadata {
  const meta: Mp4Metadata = {
    fileSize: buf.length,
    ftyp: null,
    movieTimescale: null,
    movieDurationSeconds: null,
    tracks: [],
    unknownBoxes: [],
    issues: [],
  };
  const ctx: WalkContext = { issues: meta.issues, unknownBoxes: meta.unknownBoxes, meta, track: null };
  const r = new Reader(buf);
  walk(r, buf.length, "", ctx);
  return meta;
}
