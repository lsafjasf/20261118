// Minimal EBML/WebM parser + remuxer.
// Used by the recorder page (live block counting, download remux) and by
// the Node verification script. No dependencies; works in browser and Node.

export const EBML_IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
};

const UNKNOWN_SIZE = -1;

export class EbmlReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  get remaining() {
    return this.bytes.length - this.pos;
  }

  readVintValue(maskLength = true) {
    const start = this.pos;
    if (start >= this.bytes.length) throw new Error('EBML: unexpected EOF');
    const first = this.bytes[start];
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) {
      mask >>= 1;
      length += 1;
    }
    if (length > 8 || start + length > this.bytes.length) {
      throw new Error('EBML: invalid vint');
    }
    let value = maskLength ? first & ~mask : first;
    for (let i = 1; i < length; i += 1) {
      value = value * 256 + this.bytes[start + i];
    }
    this.pos = start + length;
    // All-ones marker means "unknown size".
    if (maskLength) {
      const allOnes = Math.pow(2, 7 * length) - 1;
      if (value >= allOnes) return { value: UNKNOWN_SIZE, length };
    }
    return { value, length };
  }

  readElementHeader() {
    const start = this.pos;
    const id = this.readVintValue(false).value;
    const size = this.readVintValue(true).value;
    return { id, size, headerSize: this.pos - start, dataOffset: this.pos };
  }
}

export function readUint(bytes, offset, length) {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + bytes[offset + i];
  return value;
}

export function readFloat(bytes, offset, length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  return length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

function childElements(bytes, start, end) {
  const elements = [];
  const reader = new EbmlReader(bytes.subarray(start, end));
  while (reader.remaining > 0) {
    let header;
    try {
      header = reader.readElementHeader();
    } catch {
      break; // truncated tail (live recording still in flight)
    }
    const size = header.size === UNKNOWN_SIZE ? reader.remaining : header.size;
    if (header.dataOffset + size > reader.bytes.length) break;
    elements.push({
      id: header.id,
      dataOffset: start + header.dataOffset,
      size,
      unknownSize: header.size === UNKNOWN_SIZE,
      headerSize: header.headerSize,
      elementOffset: start + header.dataOffset - header.headerSize,
    });
    reader.pos = header.dataOffset + size;
  }
  return elements;
}

function parseBlock(bytes, offset) {
  const reader = new EbmlReader(bytes);
  reader.pos = offset;
  const track = reader.readVintValue(true).value;
  const view = new DataView(bytes.buffer, bytes.byteOffset + reader.pos, 2);
  const timecode = view.getInt16(0);
  // For Opus packets, count the laced 20ms frames for an exact duration.
  let frames = 0;
  const packetOffset = reader.pos + 3;
  if (packetOffset < bytes.length) {
    const code = bytes[packetOffset] & 0x03;
    if (code === 0) {
      frames = 1;
    } else if (code === 3 && packetOffset + 1 < bytes.length) {
      const countByte = bytes[packetOffset + 1];
      if ((countByte & 0xc0) === 0) frames = countByte & 0x3f;
    }
  }
  return { track, timecode, frames };
}

// Parses a (possibly concatenated) WebM buffer and returns track metadata,
// per-track block counts and per-track durations in milliseconds.
export function parseWebm(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const result = {
    timecodeScale: 1000000,
    tracks: [],
    blocks: [],
    clusters: [],
  };

  const top = childElements(bytes, 0, bytes.length);
  for (const element of top) {
    if (element.id !== EBML_IDS.Segment) continue;
    const segEnd = element.dataOffset + element.size;
    for (const child of childElements(bytes, element.dataOffset, segEnd)) {
      if (child.id === EBML_IDS.Info) {
        parseInfo(bytes, child, result);
      } else if (child.id === EBML_IDS.Tracks) {
        parseTracks(bytes, child, result);
      } else if (child.id === EBML_IDS.Cluster) {
        parseCluster(bytes, child, result);
      }
    }
  }
  return finalizeParse(result);
}

function parseInfo(bytes, info, result) {
  const end = info.dataOffset + info.size;
  for (const child of childElements(bytes, info.dataOffset, end)) {
    if (child.id === EBML_IDS.TimecodeScale) {
      result.timecodeScale = readUint(bytes, child.dataOffset, child.size);
    }
  }
}

function parseTracks(bytes, tracks, result) {
  const end = tracks.dataOffset + tracks.size;
  for (const entry of childElements(bytes, tracks.dataOffset, end)) {
    if (entry.id !== EBML_IDS.TrackEntry) continue;
    const track = { number: 0, type: 0, codec: '' };
    const entryEnd = entry.dataOffset + entry.size;
    for (const field of childElements(bytes, entry.dataOffset, entryEnd)) {
      if (field.id === EBML_IDS.TrackNumber) {
        track.number = readUint(bytes, field.dataOffset, field.size);
      } else if (field.id === EBML_IDS.TrackType) {
        track.type = readUint(bytes, field.dataOffset, field.size);
      } else if (field.id === EBML_IDS.CodecID) {
        track.codec = String.fromCharCode(
          ...bytes.subarray(field.dataOffset, field.dataOffset + field.size),
        );
      }
    }
    result.tracks.push(track);
  }
}

// Chrome's MediaRecorder writes Cluster elements with unknown size, so each
// cluster nominally "contains" the rest of the stream and clusters appear
// nested inside one another. This walks children in order and recurses into
// nested Cluster elements, yielding a flat, correctly ordered block list.
function parseCluster(bytes, cluster, result) {
  const end = cluster.dataOffset + cluster.size;
  let clusterTimecode = 0;
  const children = childElements(bytes, cluster.dataOffset, end);
  for (const child of children) {
    if (child.id === EBML_IDS.Timecode) {
      clusterTimecode = readUint(bytes, child.dataOffset, child.size);
      result.clusters.push({
        timecode: clusterTimecode,
        offset: cluster.elementOffset,
      });
    } else if (child.id === EBML_IDS.SimpleBlock) {
      const block = parseBlock(bytes, child.dataOffset);
      result.blocks.push({
        track: block.track,
        clusterTimecode,
        timecode: block.timecode,
        absTimecode: clusterTimecode + block.timecode,
        frames: block.frames,
      });
    } else if (child.id === EBML_IDS.BlockGroup) {
      const groupEnd = child.dataOffset + child.size;
      for (const inner of childElements(bytes, child.dataOffset, groupEnd)) {
        if (inner.id !== EBML_IDS.Block) continue;
        const block = parseBlock(bytes, inner.dataOffset);
        result.blocks.push({
          track: block.track,
          clusterTimecode,
          timecode: block.timecode,
          absTimecode: clusterTimecode + block.timecode,
          frames: block.frames,
        });
      }
    } else if (child.id === EBML_IDS.Cluster) {
      parseCluster(bytes, child, result);
    }
  }
}

function finalizeParse(result) {
  const scaleMs = result.timecodeScale / 1e6;
  const trackTypeByNumber = new Map(result.tracks.map((t) => [t.number, t.type]));
  const perTrack = new Map();
  for (const block of result.blocks) {
    const list = perTrack.get(block.track) || [];
    list.push(block);
    perTrack.set(block.track, list);
  }
  const trackStats = {};
  let videoBlocks = 0;
  let audioBlocks = 0;
  for (const [trackNumber, blocks] of perTrack) {
    blocks.sort((a, b) => a.absTimecode - b.absTimecode);
    const times = blocks.map((b) => b.absTimecode);
    const type = trackTypeByNumber.get(trackNumber) || 0;
    const deltas = [];
    for (let i = 1; i < times.length; i += 1) {
      const delta = times[i] - times[i - 1];
      if (delta > 0) deltas.push(delta);
    }
    deltas.sort((a, b) => a - b);
    const fallback = type === 1 ? 33 : 20;
    const frameDuration = deltas.length
      ? deltas[Math.floor(deltas.length / 2)]
      : fallback;
    const lastBlock = blocks[blocks.length - 1];
    const lastTime = lastBlock.absTimecode;
    const firstTime = times[0];
    // Exact duration of the final block: Opus packets carry their frame
    // count (20ms each); video falls back to the median frame interval.
    const lastDuration =
      type === 2 && lastBlock.frames > 0 ? lastBlock.frames * 20 : frameDuration;
    const endMs = (lastTime + lastDuration) * scaleMs;
    // Content span: how much media this track actually carries, independent
    // of the constant capture start offset between tracks.
    const durationMs = endMs - firstTime * scaleMs;
    trackStats[trackNumber] = {
      type,
      blocks: times.length,
      firstTimecodeMs: firstTime * scaleMs,
      lastTimecodeMs: lastTime * scaleMs,
      frameDurationMs: frameDuration * scaleMs,
      endMs,
      durationMs,
    };
    if (type === 1) videoBlocks += times.length;
    else if (type === 2) audioBlocks += times.length;
  }
  const durations = Object.values(trackStats).map((s) => s.endMs);
  return {
    timecodeScale: result.timecodeScale,
    tracks: result.tracks,
    blocks: result.blocks,
    clusters: result.clusters,
    trackStats,
    videoBlocks,
    audioBlocks,
    durationMs: durations.length ? Math.max(...durations) : 0,
  };
}

export function encodeVintSize(value) {
  let length = 1;
  while (length < 8 && value >= Math.pow(2, 7 * length) - 1) length += 1;
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  bytes[0] |= 1 << (8 - length);
  return bytes;
}

export function encodeVintId(value) {
  let length = 1;
  while (length < 4 && value >= Math.pow(2, 8 * length)) length += 1;
  const bytes = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    bytes[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return bytes;
}

function encodeUintElement(id, value) {
  const idBytes = encodeVintId(id);
  let length = 1;
  while (length < 8 && value >= Math.pow(2, 8 * length)) length += 1;
  const data = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    data[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const sizeBytes = encodeVintSize(length);
  const out = new Uint8Array(idBytes.length + sizeBytes.length + length);
  out.set(idBytes, 0);
  out.set(sizeBytes, idBytes.length);
  out.set(data, idBytes.length + sizeBytes.length);
  return out;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// Locates the Opus packet inside a SimpleBlock element slice.
// Returns offsets relative to `part`, or null if the layout is unexpected.
function opusPacketInfo(part) {
  if (part[0] !== 0xa3) return null;
  const reader = new EbmlReader(part);
  reader.readVintValue(false); // element id
  reader.readVintValue(true); // element size
  reader.readVintValue(true); // track number
  reader.pos += 2; // block timecode
  reader.pos += 1; // flags
  const packetOffset = reader.pos;
  const packetLength = part.length - packetOffset;
  if (packetLength < 2) return null;
  const toc = part[packetOffset];
  const code = toc & 0x03;
  if (code === 0) {
    return { packetOffset, packetLength, frames: 1, countByte: false, frameBytes: packetLength - 1 };
  }
  if (code !== 3) return null; // codes 1/2 not produced by Chrome's recorder
  const countByte = part[packetOffset + 1];
  const vbr = (countByte & 0x80) !== 0;
  const padding = (countByte & 0x40) !== 0;
  if (vbr || padding) return null;
  const frames = countByte & 0x3f;
  const body = packetLength - 2;
  if (frames < 1 || body % frames !== 0) return null;
  return { packetOffset, packetLength, frames, countByte: true, frameBytes: body / frames };
}

// Rebuilds a SimpleBlock audio element keeping only the first `keep` Opus
// frames (each 20ms), shrinking the packet and element sizes accordingly.
function trimAudioBlock(part, info, keep) {
  const head = part.subarray(0, info.packetOffset); // element+block headers
  let packet;
  if (keep === 1) {
    const toc = part[info.packetOffset] & 0xfc; // code 0: single frame
    packet = concatBytes([
      new Uint8Array([toc]),
      part.subarray(info.packetOffset + 2, info.packetOffset + 2 + info.frameBytes),
    ]);
  } else {
    packet = concatBytes([
      part.subarray(info.packetOffset, info.packetOffset + 1),
      new Uint8Array([keep]),
      part.subarray(info.packetOffset + 2, info.packetOffset + 2 + keep * info.frameBytes),
    ]);
  }
  // head = [0xA3][size vint][track/tc/flags...]; re-encode size for new length.
  const reader = new EbmlReader(head);
  reader.readVintValue(false); // id
  const rest = head.subarray(reader.pos); // old size vint + block header
  const sizeInfo = new EbmlReader(rest);
  sizeInfo.readVintValue(true);
  const blockHeader = rest.subarray(sizeInfo.pos); // track/tc/flags
  const payload = concatBytes([blockHeader, packet]);
  return concatBytes([
    new Uint8Array([0xa3]),
    encodeVintSize(payload.length),
    payload,
  ]);
}

// Splits a segment buffer into its header (everything before the first
// Cluster: EBML header, Segment start, Info, Tracks) and a flat, ordered
// list of clusters. Chrome writes clusters with unknown sizes so they nest
// inside each other; each returned cluster keeps only its own children
// (Timecode + block elements) as raw byte slices.
function extractClusters(bytes) {
  const headerParts = [];
  const clusters = [];

  function walkContainer(start, end) {
    const reader = new EbmlReader(bytes.subarray(start, end));
    while (reader.remaining > 0) {
      const elementStart = reader.pos;
      let header;
      try {
        header = reader.readElementHeader();
      } catch {
        return;
      }
      const size = header.size === UNKNOWN_SIZE ? reader.remaining : header.size;
      if (header.dataOffset + size > reader.bytes.length) return;
      const absStart = start + elementStart;
      const absData = start + header.dataOffset;
      const absEnd = absData + size;
      if (header.id === EBML_IDS.Cluster) {
        collectCluster(absData, absEnd);
      } else if (header.id === EBML_IDS.Segment) {
        // Keep the Segment element header, then descend.
        headerParts.push(bytes.subarray(absStart, absData));
        walkContainer(absData, absEnd);
      } else {
        headerParts.push(bytes.subarray(absStart, absEnd));
      }
      reader.pos = header.dataOffset + size;
    }
  }

  function collectCluster(start, end) {
    const cluster = { timecode: 0, parts: [] };
    // Push before recursing into nested clusters so the flat list stays
    // in document (chronological) order.
    clusters.push(cluster);
    const reader = new EbmlReader(bytes.subarray(start, end));
    while (reader.remaining > 0) {
      const elementStart = reader.pos;
      let header;
      try {
        header = reader.readElementHeader();
      } catch {
        break;
      }
      const size = header.size === UNKNOWN_SIZE ? reader.remaining : header.size;
      if (header.dataOffset + size > reader.bytes.length) break;
      const absStart = start + elementStart;
      const absData = start + header.dataOffset;
      const absEnd = absData + size;
      if (header.id === EBML_IDS.Timecode) {
        cluster.timecode = readUint(bytes, absData, size);
      } else if (header.id === EBML_IDS.Cluster) {
        collectCluster(absData, absEnd); // nested: becomes its own entry
      } else {
        cluster.parts.push(bytes.subarray(absStart, absEnd));
      }
      reader.pos = header.dataOffset + size;
    }
  }

  walkContainer(0, bytes.length);
  return { headerParts, clusters };
}

// Returns the length of the valid prefix of `input`: the offset of the first
// element whose header or body is incomplete. A recording interrupted by a
// page reload can end mid-element (e.g. a lone SimpleBlock id byte); those
// dangling bytes must be trimmed before another segment is appended.
export function findValidLength(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let trimPoint = bytes.length;

  function walk(start, end) {
    const reader = new EbmlReader(bytes.subarray(start, end));
    while (reader.remaining > 0) {
      const elementStart = reader.pos;
      let header;
      try {
        header = reader.readElementHeader();
      } catch {
        trimPoint = Math.min(trimPoint, start + elementStart);
        return;
      }
      const size = header.size === UNKNOWN_SIZE ? reader.remaining : header.size;
      if (header.dataOffset + size > reader.bytes.length) {
        trimPoint = Math.min(trimPoint, start + elementStart);
        return;
      }
      if (header.id === EBML_IDS.Segment || header.id === EBML_IDS.Cluster) {
        walk(start + header.dataOffset, start + header.dataOffset + size);
      }
      reader.pos = header.dataOffset + size;
    }
  }

  walk(0, bytes.length);
  return trimPoint;
}

// Rewrites the track number of a SimpleBlock element (raw id+size+payload
// slice). Track numbers 1-127 encode as single-byte vints, so the patch is
// done in place on a copy without changing the element size.
function remapBlockTrack(part, trackMap) {
  if (part[0] !== 0xa3) return part; // SimpleBlock id only
  const reader = new EbmlReader(part);
  reader.readVintValue(false); // element id
  reader.readVintValue(true); // element size
  const trackOffset = reader.pos;
  const track = reader.readVintValue(true).value;
  const mapped = trackMap.get(track);
  if (mapped === undefined || mapped === track) return part;
  if (track >= 128 || mapped >= 128) return part; // vint length would change
  const out = part.slice();
  out[trackOffset] = 0x80 | mapped;
  return out;
}

// Re-serializes one cluster as a flat, known-size element.
function serializeCluster(cluster) {
  const body = concatBytes([
    encodeUintElement(EBML_IDS.Timecode, cluster.timecode),
    ...cluster.parts,
  ]);
  return concatBytes([
    encodeVintId(EBML_IDS.Cluster),
    encodeVintSize(body.length),
    body,
  ]);
}

function parseBlockHeader(part) {
  const reader = new EbmlReader(part);
  reader.readVintValue(false); // element id
  reader.readVintValue(true); // element size
  const track = reader.readVintValue(true).value;
  const view = new DataView(part.buffer, part.byteOffset + reader.pos, 2);
  return { track, relTimecode: view.getInt16(0) };
}

// Aligns the track ends of the final file. Chrome stops the audio and video
// pipelines up to ~70ms apart; the requirement is one 20ms sample block.
// Audio blocks hold three laced 20ms Opus frames, so the longer track's tail
// is trimmed: audio at 20ms frame granularity, video at block granularity.
function alignTrackEnds(flat, baseTrackByType, toleranceMs = 20) {
  const videoTrack = baseTrackByType.get(1);
  const audioTrack = baseTrackByType.get(2);
  if (videoTrack === undefined || audioTrack === undefined) return;

  const videoBlocks = [];
  const audioBlocks = [];
  flat.forEach((cluster, ci) => {
    cluster.parts.forEach((part, pi) => {
      if (part[0] !== 0xa3) return;
      const { track, relTimecode } = parseBlockHeader(part);
      const entry = {
        ci,
        pi,
        track,
        absTc: cluster.timecode + relTimecode,
        opus: track === audioTrack ? opusPacketInfo(part) : null,
        keepFrames: 0,
        dropped: false,
      };
      if (track === videoTrack) videoBlocks.push(entry);
      else if (track === audioTrack) audioBlocks.push(entry);
    });
  });
  if (!videoBlocks.length || !audioBlocks.length) return;
  videoBlocks.sort((a, b) => a.absTc - b.absTc);
  audioBlocks.sort((a, b) => a.absTc - b.absTc);

  const deltas = [];
  for (let i = 1; i < videoBlocks.length; i += 1) {
    const d = videoBlocks[i].absTc - videoBlocks[i - 1].absTc;
    if (d > 0) deltas.push(d);
  }
  deltas.sort((a, b) => a - b);
  const videoFrameMs = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 50;
  const lastAlive = (list) => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!list[i].dropped) return list[i];
    }
    return null;
  };

  for (const b of audioBlocks) b.keepFrames = b.opus ? b.opus.frames : 1;

  // Align per-track spans (end - start of each track's own timeline), which
  // is what players report as stream durations. This cancels the constant
  // capture start offset and is immune to timestamp drift inside a segment.
  const firstVideoTc = videoBlocks[0].absTc;
  const firstAudioTc = audioBlocks[0].absTc;

  for (let guard = 0; guard < 60; guard += 1) {
    const lastVideo = lastAlive(videoBlocks);
    const lastAudio = lastAlive(audioBlocks);
    if (!lastVideo || !lastAudio) break;
    const videoSpan = lastVideo.absTc + videoFrameMs - firstVideoTc;
    const audioSpan =
      lastAudio.absTc + (lastAudio.opus ? lastAudio.keepFrames : 1) * 20 - firstAudioTc;
    const delta = audioSpan - videoSpan;
    if (Math.abs(delta) <= toleranceMs) break;
    if (delta > 0) {
      if (lastAudio.opus && lastAudio.keepFrames > 1) {
        lastAudio.keepFrames -= 1; // trim one 20ms Opus frame
        lastAudio.trimmed = true;
      } else {
        lastAudio.dropped = true;
      }
    } else {
      lastVideo.dropped = true;
    }
  }

  // Apply: drop marked blocks, rewrite trimmed audio blocks.
  for (const entry of [...videoBlocks, ...audioBlocks]) {
    const cluster = flat[entry.ci];
    if (entry.dropped) {
      cluster.parts[entry.pi] = null;
    } else if (entry.trimmed && entry.opus) {
      cluster.parts[entry.pi] = trimAudioBlock(
        cluster.parts[entry.pi],
        entry.opus,
        entry.keepFrames,
      );
    }
  }
  for (const cluster of flat) {
    cluster.parts = cluster.parts.filter((part) => part !== null);
  }
}

// Merges per-segment WebM recordings (each produced by its own MediaRecorder
// after a page reload) into a single WebM with a continuous timeline.
// The first segment's header is kept; every cluster (from all segments) is
// re-serialized as a flat, known-size element with timecodes shifted by the
// accumulated duration of the preceding segments. The canonical layout
// plays back in browsers (Chrome's demuxer stops at nested unknown-size
// cluster boundaries) and matches what ffmpeg produces.
export function remuxSegments(segmentBuffers) {
  const segments = segmentBuffers.map((buf) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    // Drop a dangling partial element left by an interrupted recording.
    return bytes.subarray(0, findValidLength(bytes));
  });
  if (segments.length === 0) return new Uint8Array(0);

  const extracted = segments.map((bytes) => extractClusters(bytes));
  const parsed = segments.map((bytes) => parseWebm(bytes));
  const durationsUnits = parsed.map((p, i) => {
    const scaleMs = p.timecodeScale / 1e6;
    const stats = Object.values(p.trackStats);
    if (!stats.length) return 0;
    const maxUnits = Math.max(
      ...stats.map((s) => (s.lastTimecodeMs + s.frameDurationMs) / scaleMs),
    );
    return Math.ceil(maxUnits);
  });

  const parts = [...extracted[0].headerParts];
  // Track numbers are assigned per recording session and can differ between
  // segments (e.g. segment 0: 1=video/2=audio, segment 1: 1=audio/2=video).
  // Map every segment's track numbers onto segment 0's track table by type.
  const baseTrackByType = new Map(
    parsed[0].tracks.map((track) => [track.type, track.number]),
  );
  const flat = [];
  let offsetUnits = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const trackMap = new Map();
    for (const track of parsed[i].tracks) {
      const base = baseTrackByType.get(track.type);
      trackMap.set(track.number, base === undefined ? track.number : base);
    }
    for (const cluster of extracted[i].clusters) {
      flat.push({
        timecode: cluster.timecode + offsetUnits,
        parts: cluster.parts.map((part) => remapBlockTrack(part, trackMap)),
      });
    }
    offsetUnits += durationsUnits[i];
  }

  alignTrackEnds(flat, baseTrackByType);

  for (const cluster of flat) {
    if (cluster.parts.length === 0) continue;
    parts.push(serializeCluster(cluster));
  }
  return concatBytes(parts);
}
