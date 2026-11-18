// Raw I420 frame helpers (used for ffmpeg-based end-to-end validation and
// for any packed YUV buffers outside WebCodecs).

import { hashFrameBlocks } from './hash.js';

export function i420FrameSize(width, height) {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  return width * height + 2 * chromaWidth * chromaHeight;
}

export function splitI420(buffer, width, height, frameIndex) {
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const lumaSize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  const frameSize = lumaSize + 2 * chromaSize;
  const base = frameIndex * frameSize;
  return {
    width,
    height,
    planes: [
      { width, height, stride: width, offset: base, data: buffer },
      {
        width: chromaWidth,
        height: chromaHeight,
        stride: chromaWidth,
        offset: base + lumaSize,
        data: buffer,
      },
      {
        width: chromaWidth,
        height: chromaHeight,
        stride: chromaWidth,
        offset: base + lumaSize + chromaSize,
        data: buffer,
      },
    ],
  };
}

export function hashRawI420(buffer, width, height, blockSize, samples = null) {
  const frameSize = i420FrameSize(width, height);
  const frameCount = Math.floor(buffer.length / frameSize);
  const decoded = [];
  for (let index = 0; index < frameCount; index += 1) {
    const frame = splitI420(buffer, width, height, index);
    const blockHash = hashFrameBlocks(frame, blockSize);
    decoded.push({ decodeIndex: index, blockHash });
  }
  // Raw ffmpeg output is in presentation (display) order already.
  const ptsOrder = samples
    ? samples.slice().sort((a, b) => a.pts - b.pts)
    : null;
  return decoded.map((entry, displayIndex) => {
    const sample = ptsOrder ? ptsOrder[displayIndex] : null;
    return {
      frameIndex: displayIndex,
      pts: sample ? sample.pts : displayIndex,
      sampleIndex: sample ? sample.index : displayIndex,
      decodeIndex: entry.decodeIndex,
      blockHash: {
        ...entry.blockHash,
        frameIndex: displayIndex,
        pts: sample ? sample.pts : displayIndex,
      },
    };
  });
}
