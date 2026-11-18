// Browser WebCodecs wrapper: demux via the MP4 parser, decode to I420,
// then compute per-plane block hashes.

import { parseMp4 } from './mp4.js';
import { parseAvcC, avccToAnnexB, buildAnnexBKeyframe } from './nal.js';
import { hashFrameBlocks, videoFrameToI420Descriptors } from './hash.js';

export function isWebCodecsSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export async function decodeAndHash(bytes, blockSize = 16, onProgress = null, keepDescriptors = false) {
  const mp4 = parseMp4(bytes);
  if (!mp4.avcC) throw new Error('only AVC/H.264 in MP4 containers is supported');
  const config = parseAvcC(mp4.u8, mp4.avcC.offset, mp4.avcC.length);
  const frameResults = [];
  const errors = [];
  const displayOrder = mp4.samples.slice().sort((a, b) => a.pts - b.pts);

  // Split samples into GOPs starting at each IDR. Decode GOPs independently
  // so a corrupt keyframe only damages its own GOP, never the next one.
  const gops = [];
  let current = null;
  for (const sample of mp4.samples) {
    if (sample.isKey) {
      current = [];
      gops.push(current);
    }
    if (!current) {
      current = [];
      gops.push(current);
    }
    current.push(sample);
  }

  for (const [gopIndex, gop] of gops.entries()) {
    const gopErrors = [];
    const decoder = new VideoDecoder({
      error(error) {
        gopErrors.push({ name: error.name, message: error.message });
      },
      async output(frame) {
        const ptsUnits = Math.round((frame.timestamp / 1_000_000) * mp4.timescale);
        const sample = mp4.samples.find(
          (item) => item.pts === ptsUnits || item.dts === ptsUnits,
        );
        if (!sample) {
          frame.close();
          return;
        }
        const descriptors = await videoFrameToI420Descriptors(frame);
        frame.close();
        frameResults.push({ sampleIndex: sample.index, pts: sample.pts, descriptors });
      },
    });
    decoder.configure({ codec: config.codec, optimizeForLatency: false });

    for (const sample of gop) {
      const sampleBytes = mp4.u8.subarray(sample.offset, sample.offset + sample.size);
      const annexB = sample.isKey
        ? buildAnnexBKeyframe(config, sampleBytes)
        : avccToAnnexB(sampleBytes, config.nalLengthSize);
      const chunk = new EncodedVideoChunk({
        type: sample.isKey ? 'key' : 'delta',
        timestamp: Math.round((sample.pts / mp4.timescale) * 1_000_000),
        duration: Math.round((sample.duration / mp4.timescale) * 1_000_000),
        data: annexB,
      });
      try {
        if (decoder.state !== 'closed') decoder.decode(chunk);
      } catch (error) {
        gopErrors.push({ sampleIndex: sample.index, message: error.message });
      }
    }
    try {
      if (decoder.state !== 'closed') await decoder.flush();
    } catch (error) {
      gopErrors.push({ gop: gopIndex, message: `flush failed: ${error.message}` });
    } finally {
      try { decoder.close(); } catch { /* noop */ }
    }
    if (gopErrors.length) errors.push({ gop: gopIndex, errors: gopErrors });
    if (onProgress) onProgress((gopIndex + 1) / gops.length);
  }

  const bySample = new Map(frameResults.map((result) => [result.sampleIndex, result]));
  frameResults.sort((a, b) => a.pts - b.pts);
  const frameHashes = [];
  for (const [displayIndex, sample] of displayOrder.entries()) {
    const result = bySample.get(sample.index);
    if (!result) {
      frameHashes.push({
        frameIndex: displayIndex,
        pts: sample.pts,
        dts: sample.dts,
        isKey: sample.isKey,
        sampleIndex: sample.index,
        descriptor: null,
        decodeError: true,
        blockHash: null,
      });
      continue;
    }
    const descriptor = keepDescriptors ? result.descriptors : null;
    frameHashes.push({
      frameIndex: displayIndex,
      pts: result.pts,
      dts: sample.dts,
      isKey: sample.isKey,
      sampleIndex: sample.index,
      descriptor,
      decodeError: false,
      blockHash: withIndex(hashFrameBlocks(result.descriptors, blockSize), displayIndex, result.pts),
    });
  }
  return { mp4, frameHashes, errors };
}

function withIndex(blockHash, frameIndex, pts) {
  return { ...blockHash, frameIndex, pts };
}
