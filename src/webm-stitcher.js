import { createHash } from "node:crypto";
import {
  ID,
  parseElements,
  encodeElement,
  findChild,
  readUnsigned,
} from "./ebml.js";
import { parseChunk } from "./parse-chunk.js";

const DROP_CLUSTER_CHILDREN = new Set([ID.CRC_32, ID.VOID]);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
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

function encodeFloat64(value) {
  const out = Buffer.alloc(8);
  out.writeDoubleBE(value);
  return out;
}

// Rebuild an Info element with an updated Duration (in raw timecode-scale
// units). Every other Info child is preserved.
function rewriteInfo(buf, info, durationRaw, timecodeScale) {
  const payloadParts = [];
  let hasDuration = false;
  for (const child of parseElements(buf, info.headerEnd, info.end)) {
    if (child.id === ID.CRC_32 || child.id === ID.VOID) continue;
    if (child.id === ID.DURATION) {
      payloadParts.push(encodeElement(ID.DURATION, encodeFloat64(durationRaw)));
      hasDuration = true;
    } else {
      payloadParts.push(Buffer.from(child.raw));
    }
  }
  if (!hasDuration) {
    payloadParts.push(encodeElement(ID.DURATION, encodeFloat64(durationRaw)));
  }
  return encodeElement(ID.INFO, Buffer.concat(payloadParts));
}

// Rewrite one Cluster with a continuous absolute timecode. Block relative
// timecodes stay untouched because they are offsets from the Cluster
// Timecode element.
function rewriteCluster(buf, cluster, newTimecode) {
  const source = cluster.element ?? cluster;
  const payloadParts = [];
  const children = parseElements(buf, source.headerEnd, source.end);
  for (const child of children) {
    if (child.end > source.end || child.headerEnd > child.end) continue;
    if (DROP_CLUSTER_CHILDREN.has(child.id)) continue;
    if (child.id === ID.TIMECODE) {
      payloadParts.push(
        encodeElement(ID.TIMECODE, encodeUnsigned(newTimecode)),
      );
    } else {
      payloadParts.push(Buffer.from(child.raw));
    }
  }
  return encodeElement(ID.CLUSTER, Buffer.concat(payloadParts));
}

function readTimecodeScale(buf, info) {
  if (!info) return 1000000;
  const scaleEl = findChild(buf, info, ID.TIMECODE_SCALE);
  return scaleEl ? readUnsigned(buf, scaleEl) : 1000000;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }
  if (data && typeof data.arrayBuffer === "function") {
    return Buffer.from(await data.arrayBuffer());
  }
  throw new Error("Chunk data must be a Blob, Buffer, Uint8Array or ArrayBuffer");
}

/**
 * Stitch screen-recording WebM Blob chunks into one continuous WebM Blob.
 *
 * @param {Array<{id?: string, sequence?: number, blob?: Blob|Uint8Array,
 *   data?: Blob|Uint8Array, recordedAt?: number}>} entries
 * @returns {Promise<{blob: Blob, bytes: Buffer, playlist: object}>}
 */
export async function stitchWebmChunks(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("stitchWebmChunks requires at least one chunk");
  }

  const normalized = entries.map((entry, index) => ({
    id: entry.id ?? `chunk-${index + 1}`,
    sequence: Number.isFinite(entry.sequence) ? entry.sequence : index,
    recordedAt: entry.recordedAt ?? null,
    data: entry.blob ?? entry.data,
    inputIndex: index,
  }));

  // Human-supplied order is restored explicitly; chunks arriving in reverse
  // still play in sequence order.
  const ordered = [...normalized].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.inputIndex - b.inputIndex;
  });

  const seenHashes = new Map();
  const accepted = [];
  const rejected = [];

  for (const entry of ordered) {
    const bytes = await toBytes(entry.data);
    const hash = sha256(bytes);
    if (seenHashes.has(hash)) {
      rejected.push({
        id: entry.id,
        sequence: entry.sequence,
        reason: "duplicate",
        duplicateOf: seenHashes.get(hash),
        sha256: hash,
        size: bytes.length,
      });
      continue;
    }
    seenHashes.set(hash, entry.id);
    const parsed = parseChunk(bytes);
    accepted.push({ entry, bytes, hash, parsed });
  }

  if (accepted.length === 0) {
    throw new Error("All chunks were rejected: no unique WebM data left");
  }

  const headerOwner =
    accepted.find((item) => item.parsed.ebmlHeader && item.parsed.info &&
      item.parsed.tracks) ?? accepted[0];
  const headerBuf = headerOwner.parsed.buf;
  const timecodeScale = readTimecodeScale(headerBuf, headerOwner.parsed.info);

  const outputParts = [];
  const playlistEntries = [];
  let offsetMs = 0;
  let totalDurationMs = 0;

  for (const item of accepted) {
    const { parsed, entry, hash, bytes } = item;
    const baseMs = parsed.firstTimecode;
    const clusterRewrites = [];
    for (const cluster of parsed.clusters) {
      const relativeMs = cluster.timecode - baseMs;
      const newTimecodeMs = offsetMs + relativeMs;
      clusterRewrites.push(
        rewriteCluster(parsed.buf, cluster, newTimecodeMs),
      );
    }
    outputParts.push(...clusterRewrites);

    const originalTimecodes = parsed.clusters.map((cluster) => cluster.timecode);
    playlistEntries.push({
      id: entry.id,
      sequence: entry.sequence,
      sha256: hash,
      byteSize: bytes.length,
      clusterCount: parsed.clusters.length,
      originalFirstTimecodeMs: parsed.firstTimecode,
      originalClusterTimecodesMs: originalTimecodes,
      effectiveDurationMs: parsed.durationMs,
      stitchedStartMs: offsetMs,
      stitchedEndMs: offsetMs + parsed.durationMs,
      timecodeBaseShiftMs: offsetMs - parsed.firstTimecode,
      status: "accepted",
    });

    offsetMs += parsed.durationMs;
    totalDurationMs += parsed.durationMs;
  }

  const durationRaw = (totalDurationMs * 1e6) / timecodeScale;
  const infoBytes = rewriteInfo(
    headerBuf,
    headerOwner.parsed.info,
    durationRaw,
    timecodeScale,
  );

  const segmentPayload = Buffer.concat([
    infoBytes,
    Buffer.from(headerOwner.parsed.tracks.raw),
    ...outputParts,
  ]);

  const finalBytes = Buffer.concat([
    Buffer.from(headerOwner.parsed.ebmlHeader.raw),
    encodeElement(ID.SEGMENT, segmentPayload),
  ]);

  const playlist = {
    version: 1,
    mimeType: "video/webm",
    timecodeScale,
    acceptedChunkCount: accepted.length,
    rejectedChunkCount: rejected.length,
    totalDurationMs,
    durationSeconds: totalDurationMs / 1000,
    sumOfEffectiveDurationsMs: accepted.reduce(
      (sum, item) => sum + item.parsed.durationMs,
      0,
    ),
    chunks: playlistEntries,
    rejected,
    generatedAt: new Date().toISOString(),
  };

  return {
    blob: new Blob([finalBytes], { type: "video/webm" }),
    bytes: finalBytes,
    playlist,
  };
}

export { parseChunk };
