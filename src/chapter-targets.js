// Compute the three candidate sample positions for every chapter:
// near-start, midpoint, near-end. Positions are expressed as target PTS and
// resolved against actual decoded samples by nearest-PTS matching.

export const SLOT_NAMES = ['start', 'middle', 'end'];

// Fraction of chapter duration added as inward margin for head/tail slots,
// so "near the edge" never lands exactly on the boundary frame.
const EDGE_MARGIN_RATIO = 0.1;

export function chapterSlotTargets(chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('at least one chapter is required');
  }
  return chapters.map((chapter, chapterIndex) => {
    if (chapter.endMs == null || chapter.endMs < chapter.startMs) {
      throw new Error(`chapter ${chapterIndex} has an invalid time range`);
    }
    const duration = chapter.endMs - chapter.startMs;
    const margin = duration * EDGE_MARGIN_RATIO;
    return {
      chapterIndex,
      chapter,
      slots: [
        { slot: 'start', targetPtsMs: chapter.startMs + margin },
        { slot: 'middle', targetPtsMs: chapter.startMs + duration / 2 },
        { slot: 'end', targetPtsMs: Math.max(chapter.startMs, chapter.endMs - margin) }
      ]
    };
  });
}

// Nearest sample by |pts - target|. Ties resolve to the earlier sample so the
// ordering of the three slots stays deterministic.
export function nearestSample(samples, targetPtsMs) {
  if (!samples.length) throw new Error('no samples available for target matching');
  let best = samples[0];
  let bestDistance = Math.abs(best.ptsMs - targetPtsMs);
  for (let i = 1; i < samples.length; i++) {
    const distance = Math.abs(samples[i].ptsMs - targetPtsMs);
    if (distance < bestDistance ||
        (distance === bestDistance && samples[i].ptsMs < best.ptsMs)) {
      best = samples[i];
      bestDistance = distance;
    }
  }
  return best;
}

// Resolve every chapter slot to a concrete frame. Frames are filtered to the
// chapter range first; identical PTS is only allowed when the chapter contains
// a single sample.
export function resolveChapterFrames(chapters, frames) {
  const targets = chapterSlotTargets(chapters);
  return targets.map((entry) => {
    const inRange = frames.filter(
      (frame) =>
        frame.ptsMs >= entry.chapter.startMs &&
        (entry.chapter.endMs == null || frame.ptsMs < entry.chapter.endMs)
    );
    if (inRange.length === 0) {
      throw new Error(
        `chapter ${entry.chapterIndex} ("${entry.chapter.title}") contains no frames`
      );
    }
    const chosen = entry.slots.map((slotDef) => {
      const sample = nearestSample(inRange, slotDef.targetPtsMs);
      return {
        slot: slotDef.slot,
        targetPtsMs: slotDef.targetPtsMs,
        ptsMs: sample.ptsMs,
        keyframe: sample.keyframe,
        data: sample.data,
        trackNumber: sample.trackNumber
      };
    });
    // Enforce strict PTS order start < middle < end when enough distinct
    // samples exist; collapse to distinct samples otherwise.
    const distinct = [];
    for (const item of chosen) {
      if (!distinct.some((seen) => seen.ptsMs === item.ptsMs)) distinct.push(item);
    }
    return {
      chapterIndex: entry.chapterIndex,
      chapter: entry.chapter,
      thumbnails: chosen,
      distinctThumbnails: distinct
    };
  });
}
