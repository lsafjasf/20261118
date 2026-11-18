// In-place, equal-length corruption simulation on an MP4 byte buffer.
// Every mutation is recorded with exact byte offsets so the verifier can
// map visual differences back to source-file byte ranges.

import { parseMp4, findBox } from './mp4.js';
import { nalType } from './nal.js';

const MAX_FLIPS = 1;

function cloneBytes(u8) {
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  return copy;
}

function flipByte(buffer, offset) {
  buffer[offset] ^= 0xff;
  return { offset, original: buffer[offset] ^ 0xff, mutated: buffer[offset] };
}

function perturbByte(buffer, offset, mask = 0x02) {
  const original = buffer[offset];
  buffer[offset] = original ^ mask;
  return { offset, original, mutated: buffer[offset], mask };
}

// Skip NAL start/length headers and emulation-prevention-adjacent bytes so
// the stream remains decodable (damage stays inside slice payloads).
function pickSliceOffsets(mp4, sample, nalLengthSize) {
  const start = sample.offset;
  const end = start + sample.size;
  const candidates = [];
  let cursor = start;
  while (cursor + nalLengthSize <= end) {
    let nalLength = 0;
    for (let i = 0; i < nalLengthSize; i += 1) {
      nalLength = (nalLength << 8) | mp4.u8[cursor + i];
    }
    const nalStart = cursor + nalLengthSize;
    const nalEnd = nalStart + nalLength;
    if (nalLength <= 0 || nalEnd > end) break;
    const type = nalType(mp4.u8.subarray(nalStart, nalEnd));
    // Types 1 and 5 are non-IDR / IDR slice NAL units.
    if (type === 1 || type === 5) {
      // Target deep slice payload (70-90% into the NAL) to perturb residual
      // coefficients rather than slice headers / entropy initialization,
      // giving decoders a chance to apply error concealment.
      const windowStart = nalStart + Math.floor(nalLength * 0.7);
      const windowEnd = nalEnd - 4;
      for (let k = 0; k < MAX_FLIPS; k += 1) {
        const offset = windowStart + k * Math.max(1, Math.floor((windowEnd - windowStart) / 2));
        if (offset < windowEnd) candidates.push(offset);
      }
    }
    cursor = nalEnd;
  }
  return candidates.slice(0, MAX_FLIPS);
}

function corruptSample(mp4, sample, label) {
  const buffer = cloneBytes(mp4.u8);
  const lengthSize = mp4.avcC ? readLengthSize(mp4) : 4;
  const offsets = pickSliceOffsets(mp4, sample, lengthSize);
  if (offsets.length === 0) {
    throw new Error(`${label}: no slice NAL units found in sample ${sample.index}`);
  }
  const flips = offsets.map((offset) => flipByte(buffer, offset));
  return {
    buffer,
    kind: label,
    sampleIndex: sample.index,
    byteRuns: flips.map((flip) => ({ start: flip.offset, end: flip.offset + 1 })),
    flips,
  };
}

function readLengthSize(mp4) {
  const p = mp4.avcC.offset + 4;
  return (mp4.u8[p] & 0x03) + 1;
}

export function simulateKeyframeCorruption(sourceBytes) {
  const mp4 = parseMp4(sourceBytes);
  const keyframes = mp4.samples.filter((s) => s.isKey);
  if (keyframes.length < 2) throw new Error('need at least two keyframes to bound the damage window');
  const target = keyframes[1];
  return corruptSample(mp4, target, 'keyframe');
}

export function simulatePFrameCorruption(sourceBytes) {
  const mp4 = parseMp4(sourceBytes);
  const keyframes = mp4.samples.filter((s) => s.isKey);
  if (keyframes.length < 2) throw new Error('need at least two keyframes for a bounded P-frame test');
  const windowStart = keyframes[1].index;
  // First inter sample inside the second GOP: local, temporally bounded damage.
  const target = mp4.samples.find((s, i) => i > windowStart && !s.isKey);
  if (!target) throw new Error('no P-frame found after the second keyframe');
  return corruptSample(mp4, target, 'pframe');
}

// Gentle P-frame corruption: one low-bit perturbation deep in slice residual
// data. Strict decoders (Chrome/WebCodecs) usually conceal this and still
// emit frames, so block-level damage can be visualized in the browser.
export function simulateGentlePFrameCorruption(sourceBytes) {
  const mp4 = parseMp4(sourceBytes);
  const keyframes = mp4.samples.filter((s) => s.isKey);
  if (keyframes.length < 2) throw new Error('need at least two keyframes for a bounded P-frame test');
  const windowStart = keyframes[1].index;
  const target = mp4.samples.find((s, i) => i > windowStart && !s.isKey);
  if (!target) throw new Error('no P-frame found after the second keyframe');
  const buffer = cloneBytes(mp4.u8);
  const lengthSize = readLengthSize(mp4);
  const offsets = pickSliceOffsets(mp4, target, lengthSize);
  if (offsets.length === 0) throw new Error('gentle-pframe: no slice NAL units found');
  const flips = [perturbByte(buffer, offsets[0], 0x02)];
  return {
    buffer,
    kind: 'gentle-pframe',
    sampleIndex: target.index,
    byteRuns: flips.map((flip) => ({ start: flip.offset, end: flip.offset + 1 })),
    flips,
  };
}

// Mutate container metadata only. Preference order:
//   1. free/skip box payload (pure container padding, never sample data)
//   2. mvhd reserved bytes (version 0 has 10 reserved bytes)
// The file size and every sample byte range stay identical.
export function simulateMetadataCorruption(sourceBytes) {
  const mp4 = parseMp4(sourceBytes);
  const buffer = cloneBytes(mp4.u8);
  const boxes = mp4.topLevelBoxes;
  let target = boxes.find((b) => b.type === 'free' || b.type === 'skip');

  let flips = [];
  if (target && target.end - (target.start + 8) >= 2) {
    const base = target.start + 8;
    flips = [flipByte(buffer, base), flipByte(buffer, base + 1)];
  } else {
    const mvhd = findBox(mp4.top, ['moov', 'mvhd']);
    if (!mvhd) throw new Error('no free/skip box and no mvhd box for metadata mutation');
    const version = buffer[mvhd.start + mvhd.headerSize];
    const reservedOffset = version === 1
      ? mvhd.start + mvhd.headerSize + 4 + 28
      : mvhd.start + mvhd.headerSize + 4 + 16;
    flips = [flipByte(buffer, reservedOffset), flipByte(buffer, reservedOffset + 1)];
    target = { type: 'mvhd', start: mvhd.start, end: mvhd.end };
  }

  return {
    buffer,
    kind: 'metadata',
    containerBox: target.type,
    byteRuns: flips.map((flip) => ({ start: flip.offset, end: flip.offset + 1 })),
    flips,
  };
}

export function simulateAll(sourceBytes) {
  return {
    keyframe: simulateKeyframeCorruption(sourceBytes),
    pframe: simulatePFrameCorruption(sourceBytes),
    gentlePframe: simulateGentlePFrameCorruption(sourceBytes),
    metadata: simulateMetadataCorruption(sourceBytes),
  };
}
