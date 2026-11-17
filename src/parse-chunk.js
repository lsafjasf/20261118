import {
  ID,
  parseElements,
  findChild,
  readUnsigned,
  readFloat,
  readString,
  readBlockRelativeTime,
  readBlockTrackNumber,
} from "./ebml.js";

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function inspectCluster(buf, cluster) {
  const timecodeEl = findChild(buf, cluster, ID.TIMECODE);
  const clusterTimecode = timecodeEl
    ? readUnsigned(buf, timecodeEl)
    : 0;
  const blocks = [];
  const children = parseElements(buf, cluster.headerEnd, cluster.end);
  for (const child of children) {
    if (child.end > cluster.end || child.headerEnd + 3 > child.end) continue;
    if (child.id === ID.SIMPLE_BLOCK || child.id === ID.BLOCK) {
      blocks.push({
        element: child,
        track: readBlockTrackNumber(buf, child),
        relativeTime: readBlockRelativeTime(buf, child),
      });
    }
  }
  return {
    element: cluster,
    timecode: clusterTimecode,
    blocks,
      truncated: Boolean(children.truncated),
  };
}

// Estimate how long a chunk actually lasts, in timecode units.
// The last block's true end time is unknown, so we extend it by the median
// inter-block spacing of its own track (falls back to the chunk's Info
// Duration element, then to zero).
function measureDurationMs(buf, info, clusters) {
  const allBlocks = clusters.flatMap((cluster) => cluster.blocks);
  if (allBlocks.length === 0) return 0;

  const blockCounts = new Map();
  for (const block of allBlocks) {
    blockCounts.set(block.track, (blockCounts.get(block.track) ?? 0) + 1);
  }
  let bestTrack = allBlocks[0].track;
  for (const block of allBlocks) {
    if ((blockCounts.get(block.track) ?? 0) >
        (blockCounts.get(bestTrack) ?? 0)) {
      bestTrack = block.track;
    }
  }

  const times = clusters
    .flatMap((cluster) =>
      cluster.blocks
        .filter((block) => block.track === bestTrack)
        .map((block) => cluster.timecode + block.relativeTime),
    )
    .sort((a, b) => a - b);

  const gaps = [];
  for (let i = 1; i < times.length; i += 1) {
    const gap = times[i] - times[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  const step = median(gaps);
  const lastBlockEnd = times[times.length - 1] + step;
  const firstBlockStart = times[0];
  const measured = Math.max(0, lastBlockEnd - firstBlockStart);

  if (info) {
    const durationEl = findChild(buf, info, ID.DURATION);
    const scaleEl = findChild(buf, info, ID.TIMECODE_SCALE);
    if (durationEl) {
      const scale = scaleEl ? readUnsigned(buf, scaleEl) : 1000000;
      const declared = Math.round((readFloat(buf, durationEl) * scale) / 1e6);
      // Trust the declared duration only when it is close to the measured one;
      // after a crash it frequently describes the pre-crash timeline.
      if (Math.abs(declared - measured) <= step + 1) return measured;
    }
  }
  return measured;
}

// Parse one recorded WebM Blob chunk. A chunk may either be a full WebM
// stream (EBML header + Segment) or a bare stream of Cluster elements, which
// is what MediaRecorder emits after the first chunk.
export function parseChunk(bytes) {
  const buf = Buffer.from(bytes);
  const topLevel = parseElements(buf, 0, buf.length);

  const ebmlHeader = topLevel.find((el) => el.id === ID.EBML);
  const segment = topLevel.find((el) => el.id === ID.SEGMENT);

  let info = null;
  let tracks = null;
  let clusterElements = [];

  if (segment) {
    const segmentChildren = parseElements(
      buf,
      segment.headerEnd,
      segment.end,
    );
    info = segmentChildren.find((el) => el.id === ID.INFO) ?? null;
    tracks = segmentChildren.find((el) => el.id === ID.TRACKS) ?? null;
    clusterElements = segmentChildren.filter((el) => el.id === ID.CLUSTER);
  } else {
    clusterElements = topLevel.filter((el) => el.id === ID.CLUSTER);
  }

  if (!ebmlHeader && clusterElements.length === 0) {
    throw new Error("Input is neither a WebM stream nor a list of clusters");
  }

  let docType = "webm";
  if (ebmlHeader) {
    const docTypeEl = findChild(buf, ebmlHeader, ID.DOC_TYPE);
    if (docTypeEl) docType = readString(buf, docTypeEl);
    if (docType !== "webm") {
      throw new Error(`Unsupported EBML DocType: ${docType}`);
    }
  }

  const clusters = [];
  const skippedTruncatedClusters = 0;
  for (const element of clusterElements) {
    if (element.end > buf.length) continue;
    const inspected = inspectCluster(buf, element);
    if (inspected.truncated && inspected.blocks.length === 0) continue;
    clusters.push(inspected);
  }
  const durationMs = measureDurationMs(buf, info, clusters);
  const firstTimecode = clusters.length ? clusters[0].timecode : 0;

  return {
    buf,
    ebmlHeader,
    segment,
    info,
    tracks,
    clusters,
    skippedTruncatedClusters,
    durationMs: Math.round(durationMs),
    firstTimecode,
  };
}
