// Minimal MP4 (ISO-BMFF) demuxer for non-fragmented files.
// Extracts the first video track's codec config and samples in decode order.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

function readBoxes(view, start, end, out) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type, start: pos + header, end: pos + size });
    pos += size;
  }
}

function findBox(boxes, type) {
  return boxes.find((b) => b.type === type) || null;
}

function children(view, box) {
  const out = [];
  readBoxes(view, box.start, box.end, out);
  return out;
}

// avcC / hvcC / vpcC / av1C live inside the sample entry, after its header.
// entryStart points at the entry's own box header (size+type).
function extractCodecConfig(view, entryStart, entryEnd, coding) {
  // 8 bytes box header + 78 bytes VideoSampleEntry fields.
  const boxes = [];
  readBoxes(view, entryStart + 86, entryEnd, boxes);
  for (const b of boxes) {
    if (b.type === 'avcC' || b.type === 'hvcC' || b.type === 'vpcC' || b.type === 'av1C') {
      return {
        configType: b.type,
        description: new Uint8Array(view.buffer.slice(b.start, b.end)),
      };
    }
  }
  return { configType: null, description: null };
}

function codecString(coding, configType, description) {
  if (coding === 'avc1' || coding === 'avc3') {
    // profile/compat/level from avcC bytes 1..3
    const d = description;
    const hex = (b) => b.toString(16).padStart(2, '0');
    return `avc1.${hex(d[1])}${hex(d[2])}${hex(d[3])}`;
  }
  if (coding === 'vp09' || coding === 'vp08') {
    return 'vp09.00.10.08';
  }
  if (coding === 'av01') {
    return 'av01.0.04M.08';
  }
  if (coding === 'hev1' || coding === 'hvc1') {
    return 'hev1.1.6.L93.B0';
  }
  return coding;
}

export function demux(buffer) {
  const view = new DataView(buffer);
  const top = [];
  readBoxes(view, 0, view.byteLength, top);
  const moov = findBox(top, 'moov');
  if (!moov) throw new Error('no moov box (fragmented MP4 not supported)');

  const traks = children(view, moov).filter((b) => b.type === 'trak');
  for (const trak of traks) {
    const tk = children(view, trak);
    const mdia = findBox(tk, 'mdia');
    if (!mdia) continue;
    const md = children(view, mdia);
    const hdlr = findBox(md, 'hdlr');
    const handlerType = hdlr ? String.fromCharCode(
      view.getUint8(hdlr.start + 8), view.getUint8(hdlr.start + 9),
      view.getUint8(hdlr.start + 10), view.getUint8(hdlr.start + 11)) : '';
    if (handlerType !== 'vide') continue;

    const mdhd = findBox(md, 'mdhd');
    const mdhdVersion = view.getUint8(mdhd.start);
    let timescale;
    let duration;
    if (mdhdVersion === 1) {
      timescale = view.getUint32(mdhd.start + 20);
      duration = Number(view.getBigUint64(mdhd.start + 24));
    } else {
      timescale = view.getUint32(mdhd.start + 12);
      duration = view.getUint32(mdhd.start + 16);
    }

    const minf = findBox(md, 'minf');
    const stbl = findBox(children(view, minf), 'stbl');
    const st = children(view, stbl);
    const stsd = findBox(st, 'stsd');
    const coding = String.fromCharCode(
      view.getUint8(stsd.start + 12), view.getUint8(stsd.start + 13),
      view.getUint8(stsd.start + 14), view.getUint8(stsd.start + 15));
    const { configType, description } =
      extractCodecConfig(view, stsd.start + 8, stsd.end, coding);

    const stts = findBox(st, 'stts');
    const stsz = findBox(st, 'stsz');
    const stsc = findBox(st, 'stsc');
    const stco = findBox(st, 'stco') || findBox(st, 'co64');
    const co64 = stco.type === 'co64';
    const stss = findBox(st, 'stss');
    const ctts = findBox(st, 'ctts');

    // sample sizes
    const uniform = view.getUint32(stsz.start + 4);
    const sampleCount = view.getUint32(stsz.start + 8);
    const sizes = new Uint32Array(sampleCount);
    if (uniform) {
      sizes.fill(uniform);
    } else {
      for (let i = 0; i < sampleCount; i++) sizes[i] = view.getUint32(stsz.start + 12 + i * 4);
    }

    // decoding timestamps from stts
    const dts = new Float64Array(sampleCount);
    {
      const n = view.getUint32(stts.start + 4);
      let p = stts.start + 8;
      let t = 0;
      let idx = 0;
      for (let e = 0; e < n; e++) {
        const count = view.getUint32(p);
        const delta = view.getUint32(p + 4);
        p += 8;
        for (let k = 0; k < count && idx < sampleCount; k++) {
          dts[idx++] = t;
          t += delta;
        }
      }
    }

    // composition offsets (for presentation timestamps)
    const cto = new Int32Array(sampleCount);
    if (ctts) {
      const version = view.getUint8(ctts.start);
      const n = view.getUint32(ctts.start + 4);
      let p = ctts.start + 8;
      let idx = 0;
      for (let e = 0; e < n; e++) {
        const count = view.getUint32(p);
        const off = version === 1 ? view.getInt32(p + 4) : view.getUint32(p + 4);
        p += 8;
        for (let k = 0; k < count && idx < sampleCount; k++) cto[idx++] = off;
      }
    }

    // chunk offsets
    const chunkCount = view.getUint32(stco.start + 4);
    const chunkOffsets = new Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      chunkOffsets[i] = co64
        ? Number(view.getBigUint64(stco.start + 8 + i * 8))
        : view.getUint32(stco.start + 8 + i * 4);
    }

    // sample -> chunk mapping from stsc
    const offsets = new Uint32Array(sampleCount);
    {
      const n = view.getUint32(stsc.start + 4);
      const entries = [];
      for (let i = 0; i < n; i++) {
        entries.push({
          firstChunk: view.getUint32(stsc.start + 8 + i * 12),
          samplesPerChunk: view.getUint32(stsc.start + 12 + i * 12),
        });
      }
      let sample = 0;
      for (let c = 1; c <= chunkCount; c++) {
        let spc = entries[0].samplesPerChunk;
        for (let e = 0; e < entries.length; e++) {
          if (entries[e].firstChunk <= c) spc = entries[e].samplesPerChunk;
          else break;
        }
        let off = chunkOffsets[c - 1];
        for (let k = 0; k < spc && sample < sampleCount; k++) {
          offsets[sample] = off;
          off += sizes[sample];
          sample++;
        }
      }
    }

    // keyframes
    let keyframes = null;
    if (stss) {
      const n = view.getUint32(stss.start + 4);
      keyframes = new Uint32Array(n);
      for (let i = 0; i < n; i++) keyframes[i] = view.getUint32(stss.start + 8 + i * 4) - 1;
    }

    const samples = [];
    for (let i = 0; i < sampleCount; i++) {
      samples.push({
        offset: offsets[i],
        size: sizes[i],
        cts: dts[i] + cto[i],
        dts: dts[i],
        key: keyframes ? keyframes.includes(i) : true,
      });
    }

    return {
      codec: codecString(coding, configType, description),
      coding,
      description: configType === 'vpcC' || configType === 'av1C' ? null : description,
      timescale,
      duration: duration / timescale,
      samples,
      buffer,
    };
  }
  throw new Error('no video track found');
}

export function sampleData(track, sample) {
  return new Uint8Array(track.buffer, sample.offset, sample.size);
}
