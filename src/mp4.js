import { createHash } from "node:crypto";
import {
  childBoxes,
  findBox,
  readBoxes,
  readFullBox,
  readUInt64BE,
  uint64ToNumber,
} from "./binary.js";

const CONTAINER_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex"]);

function parseMvhd(buffer, box) {
  const { version } = readFullBox(buffer, box);
  const offset = box.dataStart + 4 + (version === 1 ? 16 : 8);
  return {
    timescale: buffer.readUInt32BE(offset),
    duration: version === 1
      ? uint64ToNumber(readUInt64BE(buffer, offset + 4), "movie duration")
      : buffer.readUInt32BE(offset + 4),
  };
}

function parseTkhd(buffer, box) {
  const { version } = readFullBox(buffer, box);
  return buffer.readUInt32BE(box.dataStart + 4 + (version === 1 ? 16 : 8));
}

function parseMdhd(buffer, box) {
  const { version } = readFullBox(buffer, box);
  const offset = box.dataStart + 4 + (version === 1 ? 16 : 8);
  return {
    timescale: buffer.readUInt32BE(offset),
    duration: version === 1
      ? uint64ToNumber(readUInt64BE(buffer, offset + 4), "media duration")
      : buffer.readUInt32BE(offset + 4),
  };
}

function parseHdlr(buffer, box) {
  return buffer.toString("latin1", box.dataStart + 8, box.dataStart + 12);
}

function parseStsd(buffer, box) {
  const entries = [];
  const countOffset = box.dataStart + 4;
  if (countOffset + 4 > box.dataEnd) return entries;
  const entryOffset = countOffset + 4;
  const entryBoxes = readBoxes(buffer, entryOffset, box.dataEnd);
  for (const entry of entryBoxes) entries.push(entry.type);
  return entries;
}

function parseTrex(buffer, box) {
  return {
    trackId: buffer.readUInt32BE(box.dataStart + 4),
    defaultSampleDuration: buffer.readUInt32BE(box.dataStart + 12),
    defaultSampleSize: buffer.readUInt32BE(box.dataStart + 16),
    defaultSampleFlags: buffer.readUInt32BE(box.dataStart + 20),
  };
}

export function parseMoov(buffer, box) {
  const moovChildren = childBoxes(buffer, box);
  const mvhdBox = findBox(moovChildren, "mvhd");
  if (!mvhdBox) throw new Error("moov is missing mvhd");
  const movie = parseMvhd(buffer, mvhdBox);
  const tracks = new Map();
  const tracksArray = [];

  for (const trak of moovChildren.filter((child) => child.type === "trak")) {
    const trakChildren = childBoxes(buffer, trak);
    const tkhd = findBox(trakChildren, "tkhd");
    const mdia = findBox(trakChildren, "mdia");
    if (!tkhd || !mdia) throw new Error("trak is missing tkhd or mdia");
    const mdiaChildren = childBoxes(buffer, mdia);
    const mdhd = findBox(mdiaChildren, "mdhd");
    const hdlr = findBox(mdiaChildren, "hdlr");
    const minf = findBox(mdiaChildren, "minf");
    if (!mdhd || !hdlr || !minf) throw new Error("mdia is missing mdhd, hdlr, or minf");
    const stbl = findBox(childBoxes(buffer, minf), "stbl");
    const stsd = stbl ? findBox(childBoxes(buffer, stbl), "stsd") : null;
    const track = {
      trackId: parseTkhd(buffer, tkhd),
      handler: parseHdlr(buffer, hdlr),
      timescale: parseMdhd(buffer, mdhd).timescale,
      codecs: stsd ? parseStsd(buffer, stsd) : [],
    };
    if (tracks.has(track.trackId)) {
      throw new Error(`Duplicate track ID ${track.trackId} in moov`);
    }
    tracks.set(track.trackId, track);
    tracksArray.push(track);
  }

  const mvex = findBox(moovChildren, "mvex");
  const trex = new Map();
  if (mvex) {
    const mvexChildren = childBoxes(buffer, mvex);
    for (const box of mvexChildren.filter((child) => child.type === "trex")) {
      const defaults = parseTrex(buffer, box);
      trex.set(defaults.trackId, defaults);
    }
  }

  return { movie, tracks, tracksArray, trex, moovChildren };
}

function topLevelStructure(buffer) {
  return readBoxes(buffer);
}

export function inspectMp4(buffer, sourceName = "<buffer>") {
  const boxes = topLevelStructure(buffer);
  const moovBox = findBox(boxes, "moov");
  const moofBoxes = boxes.filter((box) => box.type === "moof");
  const ftypBox = findBox(boxes, "ftyp");
  return {
    sourceName,
    buffer,
    boxes,
    ftypBox,
    moovBox,
    moofBoxes,
    init: moovBox ? parseMoov(buffer, moovBox) : null,
    hash: createHash("sha256").update(buffer).digest("hex"),
  };
}

export { CONTAINER_TYPES };
