// Minimal WebM muxer: EBML header + Info + Tracks(video VP9) + one Cluster of
// SimpleBlocks + Chapters. Built for fixture generation, not general use.

import {
  ID,
  element,
  uintElement,
  stringElement,
  floatElement,
  concat,
  writeVint
} from './ebml.js';

function ebmlHeader() {
  return element(
    ID.HEADER,
    concat([
      uintElement(ID.EBML_VERSION, 1),
      uintElement(ID.EBML_READ_VERSION, 1),
      uintElement(ID.EBML_MAX_ID_LENGTH, 4),
      uintElement(ID.EBML_MAX_SIZE_LENGTH, 8),
      stringElement(ID.DOC_TYPE, 'webm'),
      uintElement(ID.DOC_TYPE_VERSION, 4),
      uintElement(ID.DOC_TYPE_READ_VERSION, 2)
    ])
  );
}

function infoElement(durationMs, timestampScale) {
  return element(
    ID.INFO,
    concat([
      uintElement(ID.TIMESTAMP_SCALE, timestampScale),
      stringElement(ID.MUXING_APP, 'chapter-thumbnail-wall-tests'),
      stringElement(ID.WRITING_APP, 'chapter-thumbnail-wall-tests'),
      floatElement(ID.DURATION, (durationMs * 1_000_000) / timestampScale)
    ])
  );
}

function videoTrackElement(width, height) {
  return element(
    ID.TRACKS,
    element(
      ID.TRACK_ENTRY,
      concat([
        uintElement(ID.TRACK_NUMBER, 1),
        uintElement(ID.TRACK_UID, 1),
        uintElement(ID.TRACK_TYPE, 1), // video
        uintElement(ID.FLAG_LACING, 0),
        stringElement(ID.CODEC_ID, 'V_VP9'),
        element(
          ID.VIDEO,
          concat([
            uintElement(ID.PIXEL_WIDTH, width),
            uintElement(ID.PIXEL_HEIGHT, height)
          ])
        )
      ])
    )
  );
}

function simpleBlock(frameBytes, keyframe) {
  const trackVint = writeVint(1);
  // Relative timecode is zero because every frame lives in its own cluster
  // whose Timestamp element carries the absolute PTS.
  const relTime = new Uint8Array([0, 0]);
  const flags = new Uint8Array([keyframe ? 0x80 : 0x00]);
  const payload = concat([trackVint, relTime, flags, frameBytes]);
  return element(ID.SIMPLE_BLOCK, payload);
}

function clusterElement(frame) {
  return element(
    ID.CLUSTER,
    concat([
      uintElement(ID.TIMESTAMP, frame.ptsMs),
      simpleBlock(frame.data, frame.keyframe !== false)
    ])
  );
}

function chaptersElement(chapters, timestampScale) {
  const atoms = chapters.map((chapter) => {
    const meta = element(
      ID.DISPLAY_META,
      concat([
        stringElement(ID.CHAP_STRING, chapter.title),
        stringElement(ID.CHAP_LANG, 'und')
      ])
    );
    const startScale = Math.round((chapter.startMs * 1_000_000) / timestampScale);
    const endScale = Math.round((chapter.endMs * 1_000_000) / timestampScale);
    return element(
      ID.CHAPTER_ATOM,
      concat([
        uintElement(ID.CHAPTER_UID, chapter.uid),
        uintElement(ID.CHAPTER_TIME_START, startScale),
        uintElement(ID.CHAPTER_TIME_END, endScale),
        uintElement(ID.CHAPTER_FLAG_HIDDEN, 0),
        uintElement(ID.CHAPTER_FLAG_ENABLED, 1),
        meta
      ])
    );
  });
  const edition = element(
    ID.EDITION_ENTRY,
    concat([uintElement(ID.EDITION_FLAG_DEFAULT, 1), ...atoms])
  );
  return element(ID.CHAPTERS, edition);
}

// frames: [{ ptsMs, data: Uint8Array, keyframe }]
// chapters: [{ uid, startMs, endMs, title }]
export function buildWebm({ width, height, frames, chapters, timestampScale = 1_000_000 }) {
  if (!frames.length) throw new Error('buildWebm: at least one frame is required');
  const lastPts = frames[frames.length - 1].ptsMs;
  const durationMs = Math.max(lastPts + 1, chapters.at(-1)?.endMs ?? 0);
  const segmentPayload = concat([
    infoElement(durationMs, timestampScale),
    videoTrackElement(width, height),
    ...frames.map((frame) => clusterElement(frame)),
    chaptersElement(chapters, timestampScale)
  ]);
  return concat([ebmlHeader(), element(ID.SEGMENT, segmentPayload)]);
}
