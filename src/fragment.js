import {
  childBoxes,
  findBox,
  readFullBox,
  readUInt64BE,
  uint64ToNumber,
} from "./binary.js";

function parseMfhd(buffer, box) {
  return buffer.readUInt32BE(box.dataStart + 4);
}

function parseTfhd(buffer, box) {
  const { flags } = readFullBox(buffer, box);
  let offset = box.dataStart + 8;
  const result = {
    trackId: buffer.readUInt32BE(box.dataStart + 4),
    flags,
    baseDataOffset: null,
    defaultSampleDuration: null,
    defaultSampleSize: null,
    defaultSampleFlags: null,
    defaultBaseIsMoof: Boolean(flags & 0x20000),
  };

  if (flags & 0x1) {
    result.baseDataOffset = readUInt64BE(buffer, offset);
    offset += 8;
  }
  if (flags & 0x2) offset += 4;
  if (flags & 0x8) {
    result.defaultSampleDuration = buffer.readUInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x10) {
    result.defaultSampleSize = buffer.readUInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x20) {
    result.defaultSampleFlags = buffer.readUInt32BE(offset);
  }
  return result;
}

function parseTfdt(buffer, box) {
  const { version } = readFullBox(buffer, box);
  return version === 1
    ? readUInt64BE(buffer, box.dataStart + 4)
    : BigInt(buffer.readUInt32BE(box.dataStart + 4));
}

function parseTrun(buffer, box) {
  const { version, flags } = readFullBox(buffer, box);
  const sampleCount = buffer.readUInt32BE(box.dataStart + 4);
  let offset = box.dataStart + 8;
  let dataOffset = null;
  let firstSampleFlags = null;

  if (flags & 0x1) {
    dataOffset = buffer.readInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x4) {
    firstSampleFlags = buffer.readUInt32BE(offset);
    offset += 4;
  }

  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = {
      duration: null,
      size: null,
      flags: null,
      compositionOffset: 0n,
    };
    if (flags & 0x100) {
      sample.duration = buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (flags & 0x200) {
      sample.size = buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (flags & 0x400) {
      sample.flags = buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (flags & 0x800) {
      sample.compositionOffset = version === 1
        ? BigInt(buffer.readInt32BE(offset))
        : BigInt(buffer.readUInt32BE(offset));
      offset += 4;
    }
    samples.push(sample);
  }
  if (offset > box.dataEnd) throw new Error("trun sample data exceeds box boundary");

  return { sampleCount, dataOffset, firstSampleFlags, samples };
}

function isSyncSample(flags) {
  const nonSync = (flags & 0x10000) !== 0;
  const dependsOn = (flags >>> 24) & 0x3;
  return !nonSync && dependsOn !== 1;
}

function trackTimescale(init, trackId) {
  const track = init?.tracks.get(trackId);
  if (!track) throw new Error(`Fragment references unknown track ID ${trackId}`);
  return track.timescale;
}

function parseTraf(buffer, trafBox, init) {
  const children = childBoxes(buffer, trafBox);
  const tfhdBox = findBox(children, "tfhd");
  if (!tfhdBox) throw new Error("traf is missing tfhd");
  const tfhd = parseTfhd(buffer, tfhdBox);
  const tfdtBox = findBox(children, "tfdt");
  const baseDecodeTime = tfdtBox ? parseTfdt(buffer, tfdtBox) : null;
  const trex = init.trex.get(tfhd.trackId) ?? {};
  const timescale = trackTimescale(init, tfhd.trackId);
  const defaultDuration =
    tfhd.defaultSampleDuration ?? trex.defaultSampleDuration ?? 0;
  const defaultFlags = tfhd.defaultSampleFlags ?? trex.defaultSampleFlags ?? 0;
  const truns = children
    .filter((box) => box.type === "trun")
    .map((box) => parseTrun(buffer, box));
  if (truns.length === 0) throw new Error("traf is missing trun");

  let decodeOffset = 0n;
  let sampleCount = 0;
  const keyframes = [];
  const samples = [];

  for (const trun of truns) {
    for (let index = 0; index < trun.samples.length; index += 1) {
      const sample = trun.samples[index];
      const duration = sample.duration ?? defaultDuration;
      if (!duration) {
        throw new Error(
          `Track ${tfhd.trackId} has a sample with no duration and no default duration`,
        );
      }
      const flags = index === 0 && trun.firstSampleFlags !== null
        ? trun.firstSampleFlags
        : sample.flags ?? defaultFlags;
      const presentationTime = decodeOffset + sample.compositionOffset;
      if (isSyncSample(flags)) {
        keyframes.push({
          sampleIndex: sampleCount,
          decodeTimeTicks: decodeOffset,
          presentationTimeTicks: presentationTime,
        });
      }
      samples.push({
        duration,
        decodeTimeTicks: decodeOffset,
        presentationTimeTicks: presentationTime,
        isKeyframe: isSyncSample(flags),
      });
      decodeOffset += BigInt(duration);
      sampleCount += 1;
    }
  }

  return {
    trackId: tfhd.trackId,
    timescale,
    baseDecodeTime,
    durationTicks: decodeOffset,
    durationSeconds: Number(decodeOffset) / timescale,
    sampleCount,
    keyframes,
    samples,
  };
}

export function parseMoof(buffer, moofBox, init) {
  const children = childBoxes(buffer, moofBox);
  const mfhdBox = findBox(children, "mfhd");
  if (!mfhdBox) throw new Error("moof is missing mfhd");
  const trafs = children
    .filter((box) => box.type === "traf")
    .map((box) => parseTraf(buffer, box, init));
  if (trafs.length === 0) throw new Error("moof contains no traf");
  const tracks = new Map();
  for (const traf of trafs) {
    if (tracks.has(traf.trackId)) {
      throw new Error(`moof declares track ${traf.trackId} more than once`);
    }
    tracks.set(traf.trackId, traf);
  }
  return {
    sequenceNumber: parseMfhd(buffer, mfhdBox),
    tracks,
    sampleCount: trafs.reduce((sum, traf) => sum + traf.sampleCount, 0),
    durationSeconds: Math.max(...trafs.map((traf) => traf.durationSeconds)),
  };
}

export function decodeTimeNumber(value, label) {
  return uint64ToNumber(value, label);
}
