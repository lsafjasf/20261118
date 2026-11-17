// Streaming-safe WebM/Matroska parser focused on the data the thumbnail
// pipeline needs: chapters, the single video track, and timestamped frames.
// Parsing is random-access on an ArrayBuffer; encoded frame bytes are copied
// into standalone ArrayBuffers so the source buffer can be freed afterwards.

import {
  ID,
  children,
  findChild,
  readUint,
  readFloat,
  readString,
  readVint
} from './ebml.js';

function parseChapters(bytes, start, end) {
  const chapters = [];
  for (const edition of children(bytes, start, end)) {
    if (edition.id !== ID.EDITION_ENTRY) continue;
    for (const atom of children(bytes, edition.start, edition.end)) {
      if (atom.id !== ID.CHAPTER_ATOM) continue;
      const startEl = findChild(bytes, atom.start, atom.end, ID.CHAPTER_TIME_START);
      const endEl = findChild(bytes, atom.start, atom.end, ID.CHAPTER_TIME_END);
      const metaEl = findChild(bytes, atom.start, atom.end, ID.DISPLAY_META);
      let title = '';
      if (metaEl) {
        const titleEl = findChild(bytes, metaEl.start, metaEl.end, ID.CHAP_STRING);
        if (titleEl) title = readString(bytes, titleEl.start, titleEl.end);
      }
      chapters.push({
        uid: (() => {
          const uidEl = findChild(bytes, atom.start, atom.end, ID.CHAPTER_UID);
          return uidEl ? readUint(bytes, uidEl.start, uidEl.end) : null;
        })(),
        timecode: startEl ? readUint(bytes, startEl.start, startEl.end) : 0,
        endTimecode: endEl ? readUint(bytes, endEl.start, endEl.end) : null,
        title
      });
    }
  }
  return chapters;
}

function parseTracks(bytes, start, end) {
  const tracks = [];
  for (const entry of children(bytes, start, end)) {
    if (entry.id !== ID.TRACK_ENTRY) continue;
    const numEl = findChild(bytes, entry.start, entry.end, ID.TRACK_NUMBER);
    const typeEl = findChild(bytes, entry.start, entry.end, ID.TRACK_TYPE);
    const codecEl = findChild(bytes, entry.start, entry.end, ID.CODEC_ID);
    const videoEl = findChild(bytes, entry.start, entry.end, ID.VIDEO);
    const track = {
      trackNumber: numEl ? readUint(bytes, numEl.start, numEl.end) : null,
      trackType: typeEl ? readUint(bytes, typeEl.start, typeEl.end) : null,
      codecId: codecEl ? readString(bytes, codecEl.start, codecEl.end) : '',
      width: null,
      height: null
    };
    if (videoEl) {
      const widthEl = findChild(bytes, videoEl.start, videoEl.end, ID.PIXEL_WIDTH);
      const heightEl = findChild(bytes, videoEl.start, videoEl.end, ID.PIXEL_HEIGHT);
      track.width = widthEl ? readUint(bytes, widthEl.start, widthEl.end) : null;
      track.height = heightEl ? readUint(bytes, heightEl.start, heightEl.end) : null;
    }
    tracks.push(track);
  }
  return tracks;
}

function parseBlock(bytes, dataStart, dataEnd, clusterTimecodeMs) {
  // Block / SimpleBlock: track number vint, int16 relative timecode, flags byte
  const track = readVint(bytes, dataStart);
  const relStart = dataStart + track.length;
  // Signed int16 big-endian; <<16 then >>16 sign-extends in 32 bits.
  const relTimecode = ((bytes[relStart] << 8) | bytes[relStart + 1]) << 16 >> 16;
  const flags = bytes[relStart + 2];
  const frameStart = relStart + 3;
  const keyframe = (flags & 0x80) === 0x80;
  return {
    trackNumber: track.value,
    ptsMs: clusterTimecodeMs + relTimecode,
    keyframe,
    frameStart,
    frameEnd: dataEnd
  };
}

export function parseWebm(buffer) {
  const bytes = new Uint8Array(buffer);
  let segment = null;
  let timestampScale = 1_000_000;
  let durationScale = null;
  const rawChapters = [];
  const tracks = [];
  const frames = [];

  for (const top of children(bytes, 0, bytes.length)) {
    if (top.id === ID.SEGMENT) {
      segment = top;
    }
  }
  if (!segment) throw new Error('WebM: Segment element not found');

  for (const level1 of children(bytes, segment.start, segment.end)) {
    if (level1.id === ID.INFO) {
      const scaleEl = findChild(bytes, level1.start, level1.end, ID.TIMESTAMP_SCALE);
      if (scaleEl) timestampScale = readUint(bytes, scaleEl.start, scaleEl.end);
      const durationEl = findChild(bytes, level1.start, level1.end, ID.DURATION);
      if (durationEl) durationScale = readFloat(bytes, durationEl.start, durationEl.end);
    } else if (level1.id === ID.CHAPTERS) {
      rawChapters.push(...parseChapters(bytes, level1.start, level1.end));
    } else if (level1.id === ID.TRACKS) {
      tracks.push(...parseTracks(bytes, level1.start, level1.end));
    } else if (level1.id === ID.CLUSTER) {
      const tcEl = findChild(bytes, level1.start, level1.end, ID.TIMESTAMP);
      const clusterTimecodeMs = tcEl
        ? readUint(bytes, tcEl.start, tcEl.end)
        : 0;
      for (const block of children(bytes, level1.start, level1.end)) {
        if (block.id === ID.SIMPLE_BLOCK || block.id === ID.BLOCK) {
          const info = parseBlock(bytes, block.start, block.end, clusterTimecodeMs);
          // Copy frame bytes so callers can drop the whole-file buffer.
          const data = bytes.slice(info.frameStart, info.frameEnd);
          frames.push({
            trackNumber: info.trackNumber,
            ptsMs: info.ptsMs,
            keyframe: info.keyframe,
            data
          });
        }
      }
    }
  }

  frames.sort((a, b) => a.ptsMs - b.ptsMs);

  // Chapter timecodes share the segment TimestampScale, so a timecode of N
  // scales maps to N * timestampScale nanoseconds.
  const scaleToMs = (timecode) => (timecode * timestampScale) / 1_000_000;
  const chapters = rawChapters
    .map((chapter) => ({
      uid: chapter.uid,
      title: chapter.title,
      startMs: scaleToMs(chapter.timecode),
      endMs:
        chapter.endTimecode == null
          ? null
          : scaleToMs(chapter.endTimecode)
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const durationMs = durationScale == null ? null : scaleToMs(durationScale);
  return { timestampScale, durationMs, chapters, tracks, frames };
}
