import { CONFIG, segmentStart, totalSegments } from './config.js';

export const TRACK_NAMES = ['video', 'audio', 'text'];

// 分片大小 = 轨道码率 × 分片时长 / 8。
export function segmentSize(trackName) {
  const bitrate = CONFIG.TRACKS[trackName].bitrate;
  return Math.round((bitrate * CONFIG.SEGMENT_DURATION) / 8);
}

export function makeSegment(trackName, index) {
  if (index < 0 || index >= totalSegments()) return null;
  return {
    track: trackName,
    index,
    start: segmentStart(index),
    end: Math.min(segmentStart(index) + CONFIG.SEGMENT_DURATION, CONFIG.DURATION),
    size: segmentSize(trackName),
  };
}
