// Minimal ISO-BMFF (MP4/MOV) box parser for H.264/AVC integrity checks.
// Pure logic: operates on Uint8Array / ArrayBuffer, no DOM or WebCodecs.

const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta',
  'meta', 'moof', 'traf', 'mvex', 'stsd', 'iprp', 'ipco',
  'avc1', 'hvc1', 'hev1', 'mp4a', 'avc3',
]);

const FULL_BOX_SKIP = new Set(['meta', 'stsd']);

export function parseBoxes(view, start = 0, end = view.byteLength) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = fourcc(view, pos + 4);
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    const box = { type, start: pos, end: pos + size, size, headerSize };
    boxes.push(box);
    if (CONTAINERS.has(type)) {
      box.children = parseBoxes(view, childStart(view, box), box.end);
    }
    pos += size;
  }
  return boxes;
}

function childStart(view, box) {
  let pos = box.start + box.headerSize;
  if (box.type === 'meta') pos += 4; // version/flags
  if (box.type === 'stsd') pos += 8; // version/flags + entry count
  if (box.type === 'avc1' || box.type === 'avc3' ||
      box.type === 'hvc1' || box.type === 'hev1') {
    pos += 78; // SampleEntry (8) + VisualSampleEntry fixed fields (70)
  }
  return pos;
}

export function findBox(boxes, path) {
  let current = boxes;
  let hit = null;
  for (const name of path) {
    hit = (current || []).find((b) => b.type === name);
    if (!hit) return null;
    current = hit.children;
  }
  return hit;
}

export function findAll(boxes, type, out = []) {
  for (const box of boxes) {
    if (box.type === type) out.push(box);
    if (box.children) findAll(box.children, type, out);
  }
  return out;
}

function fourcc(view, offset) {
  let s = '';
  for (let i = 0; i < 4; i += 1) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export function parseMp4(bytes) {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer : bytes;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(buffer);
  const view = new DataView(buffer);
  const top = parseBoxes(view);
  const stbl = findBox(top, ['moov', 'trak', 'mdia', 'minf', 'stbl']);
  if (!stbl) throw new Error('not a supported ISO-BMFF file: stbl box missing');

  const stsz = findBox(stbl.children, ['stsz']);
  const stsc = findBox(stbl.children, ['stsc']);
  const stco = findBox(stbl.children, ['stco']);
  const co64 = findBox(stbl.children, ['co64']);
  const stts = findBox(stbl.children, ['stts']);
  const ctts = findBox(stbl.children, ['ctts']);
  const stss = findBox(stbl.children, ['stss']);
  const avcC = findAll(stbl.children, 'avcC')[0] || null;

  const sizes = parseSizes(view, stsz);
  const chunkOffsets = stco
    ? parseOffsets32(view, stco)
    : parseOffsets64(view, co64);
  const chunks = expandStsc(view, stsc, chunkOffsets.length);
  const keySet = stss ? new Set(parseStss(view, stss)) : new Set(sizes.map((_, i) => i));
  const timing = parseStts(view, stts);
  const cts = ctts ? parseCtts(view, ctts) : new Map();
  const mdhd = findBox(top, ['moov', 'trak', 'mdia', 'mdhd']);
  const timescale = parseTimescale(view, mdhd);

  const samples = buildSamples(sizes, chunkOffsets, chunks, timing, cts, keySet);
  const moov = findBox(top, ['moov']);
  const mdat = top.find((b) => b.type === 'mdat') || null;

  return {
    u8,
    top,
    topLevelBoxes: top.map(({ type, start, end }) => ({ type, start, end })),
    moov,
    mdat,
    avcC: avcC ? { offset: avcC.start + avcC.headerSize, length: avcC.size - avcC.headerSize, box: avcC } : null,
    timescale,
    sampleCount: samples.length,
    samples,
  };
}

function parseSizes(view, stsz) {
  const p = stsz.start + stsz.headerSize;
  const uniform = view.getUint32(p + 4);
  const count = view.getUint32(p + 8);
  if (uniform) return new Array(count).fill(uniform);
  const sizes = [];
  for (let i = 0; i < count; i += 1) sizes.push(view.getUint32(p + 12 + i * 4));
  return sizes;
}

function parseOffsets32(view, box) {
  const p = box.start + box.headerSize + 4;
  const count = view.getUint32(p);
  const offsets = [];
  for (let i = 0; i < count; i += 1) offsets.push(view.getUint32(p + 4 + i * 4));
  return offsets;
}

function parseOffsets64(view, box) {
  const p = box.start + box.headerSize + 4;
  const count = view.getUint32(p);
  const offsets = [];
  for (let i = 0; i < count; i += 1) offsets.push(Number(view.getBigUint64(p + 4 + i * 8)));
  return offsets;
}

function expandStsc(view, box, chunkCount) {
  const p = box.start + box.headerSize + 4;
  const entries = view.getUint32(p);
  const table = [];
  for (let i = 0; i < entries; i += 1) {
    table.push({
      firstChunk: view.getUint32(p + 4 + i * 12) - 1,
      perChunk: view.getUint32(p + 8 + i * 12),
    });
  }
  const perChunk = [];
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    let active = table[0];
    for (const row of table) if (row.firstChunk <= chunk) active = row;
    perChunk.push(active.perChunk);
  }
  return perChunk;
}

function parseStss(view, box) {
  const p = box.start + box.headerSize + 4;
  const count = view.getUint32(p);
  const indexes = [];
  for (let i = 0; i < count; i += 1) indexes.push(view.getUint32(p + 4 + i * 4) - 1);
  return indexes;
}

function parseStts(view, box) {
  const p = box.start + box.headerSize + 4;
  const entries = view.getUint32(p);
  const deltas = [];
  for (let i = 0; i < entries; i += 1) {
    const count = view.getUint32(p + 4 + i * 8);
    const delta = view.getUint32(p + 8 + i * 8);
    for (let j = 0; j < count; j += 1) deltas.push(delta);
  }
  return deltas;
}

function parseCtts(view, box) {
  const p = box.start + box.headerSize + 4;
  const entries = view.getUint32(p);
  const offsets = new Map();
  let index = 0;
  for (let i = 0; i < entries; i += 1) {
    const count = view.getUint32(p + 4 + i * 8);
    const value = view.getUint32(p + 8 + i * 8);
    for (let j = 0; j < count; j += 1) {
      offsets.set(index, value);
      index += 1;
    }
  }
  return offsets;
}

function parseTimescale(view, mdhd) {
  if (!mdhd) return 1;
  const version = view.getUint8(mdhd.start + mdhd.headerSize);
  const p = mdhd.start + mdhd.headerSize;
  return version === 1 ? view.getUint32(p + 20) : view.getUint32(p + 12);
}

function buildSamples(sizes, chunkOffsets, perChunk, deltas, cts, keySet) {
  const samples = [];
  let sampleIndex = 0;
  let dts = 0;
  for (let chunk = 0; chunk < chunkOffsets.length; chunk += 1) {
    let within = 0;
    for (let j = 0; j < perChunk[chunk]; j += 1) {
      const size = sizes[sampleIndex];
      const offset = chunkOffsets[chunk] + within;
      const duration = deltas[sampleIndex] || 0;
      const composition = cts.get(sampleIndex) || 0;
      samples.push({
        index: sampleIndex,
        offset,
        size,
        byteRange: [offset, offset + size],
        dts,
        pts: dts + composition,
        duration,
        isKey: keySet.has(sampleIndex),
      });
      within += size;
      dts += duration;
      sampleIndex += 1;
    }
  }
  return samples;
}

export function sampleAtOffset(mp4, offset) {
  return mp4.samples.find((s) => offset >= s.offset && offset < s.offset + s.size) || null;
}

export function classifyOffset(mp4, offset) {
  const sample = sampleAtOffset(mp4, offset);
  if (sample) return { kind: 'sample', sampleIndex: sample.index };
  if (mp4.moov && offset >= mp4.moov.start && offset < mp4.moov.end) {
    return { kind: 'metadata', region: 'moov' };
  }
  const box = (mp4.top || mp4.topLevelBoxes).find((b) => offset >= b.start && offset < b.end);
  return { kind: 'container', region: box ? box.type : 'unknown' };
}
