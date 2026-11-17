// Export manifest builder. The manifest is the persistent record of the
// thumbnail wall: every thumbnail keeps its source frame PTS, the chapter it
// belongs to, and which slot (start/middle/end) it represents.

function blobToDataUrl(blob) {
  if (typeof FileReader === 'undefined') {
    throw new Error('FileReader is required to serialize blobs in this environment');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// selections: optional Map(chapterIndex -> { slot, ptsMs }). Defaults to the
// middle slot when the user has not picked a representative frame.
export function buildManifest(wall, selections) {
  const generatedAt = new Date().toISOString();
  const chapters = wall.chapters.map((chapter) => {
    const selection = selections?.get(chapter.chapterIndex);
    const thumbnails = chapter.thumbnails.map((thumbnail) => ({
      slot: thumbnail.slot,
      sourcePtsMs: thumbnail.ptsMs,
      targetPtsMs: thumbnail.targetPtsMs,
      keyframe: thumbnail.keyframe,
      width: thumbnail.width,
      height: thumbnail.height,
      imageFile: `thumbnails/ch${String(chapter.chapterIndex + 1).padStart(2, '0')}-${thumbnail.slot}.png`
    }));
    const selected =
      thumbnails.find(
        (item) => selection && item.slot === selection.slot && item.sourcePtsMs === selection.ptsMs
      ) ?? thumbnails.find((item) => item.slot === 'middle') ?? thumbnails[0];
    return {
      chapterIndex: chapter.chapterIndex,
      title: chapter.title,
      startMs: chapter.startMs,
      endMs: chapter.endMs,
      thumbnails,
      selected: {
        slot: selected.slot,
        sourcePtsMs: selected.sourcePtsMs
      }
    };
  });

  return {
    schemaVersion: 1,
    generatedAt,
    source: wall.source,
    concurrency: wall.stats.concurrency,
    chapters
  };
}

// Convenience export: manifest JSON plus one PNG Blob per thumbnail, laid out
// according to the imageFile paths used in the manifest.
export async function buildExportBundle(wall, selections) {
  const manifest = buildManifest(wall, selections);
  const files = [];
  for (const chapter of wall.chapters) {
    for (const thumbnail of chapter.thumbnails) {
      const entry = manifest.chapters
        .find((item) => item.chapterIndex === chapter.chapterIndex)
        .thumbnails.find((item) => item.slot === thumbnail.slot);
      files.push({ path: entry.imageFile, blob: thumbnail.blob });
    }
  }
  const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], {
    type: 'application/json'
  });
  files.push({ path: 'manifest.json', blob: manifestBlob });
  return { manifest, files, manifestDataUrl: await blobToDataUrl(manifestBlob) };
}
