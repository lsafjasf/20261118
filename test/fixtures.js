import { readFileSync } from "node:fs";
import {
  ID,
  parseElements,
  encodeElement,
  findChild,
  readUnsigned,
} from "../src/ebml.js";

// Split a real WebM file into MediaRecorder-style chunks. Each restart chunk
// is a full WebM stream (EBML + Segment with Info/Tracks) containing one
// Cluster, which is what a recorder emits after pause/resume or a crash.
// `timecodeShiftMs` moves the Cluster Timecode backwards/forwards to emulate
// discontinuous timestamps.
export function buildChunks(sourcePath, options = {}) {
  const buf = readFileSync(sourcePath);
  const topLevel = parseElements(buf, 0, buf.length);
  const ebmlHeader = topLevel.find((el) => el.id === ID.EBML);
  const segment = topLevel.find((el) => el.id === ID.SEGMENT);
  const segmentChildren = parseElements(
    buf,
    segment.headerEnd,
    segment.end,
  );
  const info = segmentChildren.find((el) => el.id === ID.INFO);
  const tracks = segmentChildren.find((el) => el.id === ID.TRACKS);
  const clusters = segmentChildren.filter((el) => el.id === ID.CLUSTER);

  const shifts = options.shifts ?? clusters.map(() => 0);
  return clusters.map((cluster, index) => {
    const shifted = shiftCluster(buf, cluster, shifts[index] ?? 0);
    const payload = Buffer.concat([
      Buffer.from(info.raw),
      Buffer.from(tracks.raw),
      shifted,
    ]);
    return Buffer.concat([
      Buffer.from(ebmlHeader.raw),
      encodeElement(ID.SEGMENT, payload),
    ]);
  });
}

function shiftCluster(buf, cluster, shiftMs) {
  if (shiftMs === 0) return Buffer.from(cluster.raw);
  const timecodeEl = findChild(buf, cluster, ID.TIMECODE);
  const original = readUnsigned(buf, timecodeEl);
  const target = Math.max(0, original + shiftMs);
  const parts = [];
  for (const child of parseElements(buf, cluster.headerEnd, cluster.end)) {
    if (child.id === ID.TIMECODE) {
      parts.push(encodeElement(ID.TIMECODE, encodeUnsigned(target)));
    } else {
      parts.push(Buffer.from(child.raw));
    }
  }
  return encodeElement(ID.CLUSTER, Buffer.concat(parts));
}

function encodeUnsigned(value) {
  if (value === 0) return Buffer.alloc(1);
  const bytes = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.trunc(remaining / 256);
  }
  return Buffer.from(bytes);
}

// Bare Cluster chunks (no EBML header), like ondataavailable after the first
// timeslice while the recorder keeps running.
export function buildBareClusterChunks(sourcePath) {
  const buf = readFileSync(sourcePath);
  const segment = parseElements(buf, 0, buf.length).find(
    (el) => el.id === ID.SEGMENT,
  );
  return parseElements(buf, segment.headerEnd, segment.end)
    .filter((el) => el.id === ID.CLUSTER)
    .map((cluster) => Buffer.from(cluster.raw));
}
