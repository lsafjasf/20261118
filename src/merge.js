import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  childBoxes,
  findBox,
  readBoxes,
  readFullBox,
  sliceBox,
  writeUInt64BE,
} from "./binary.js";
import { inspectMp4 } from "./mp4.js";
import { parseMoof } from "./fragment.js";

export class MergeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MergeError";
    this.code = code;
    this.details = details;
  }
}

const DROPPED_TOP_LEVEL = new Set(["ftyp", "moov", "sidx", "ssix", "mfra", "mfro"]);

function trailingSequence(filename) {
  const basename = path.basename(filename);
  const match = basename.match(/(\d+)(?=\.[^.]+$)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function firstMoofSequence(info) {
  if (info.moofBoxes.length === 0) return null;
  const children = childBoxes(info.buffer, info.moofBoxes[0]);
  const mfhd = findBox(children, "mfhd");
  return mfhd ? info.buffer.readUInt32BE(mfhd.dataStart + 4) : null;
}

function initSignature(init) {
  return init.tracksArray
    .map((track) => `${track.trackId}:${track.handler}:${track.timescale}:${track.codecs.join(",")}`)
    .sort()
    .join("|");
}

function validateInitConsistency(reference, candidate, sourceName) {
  if (!candidate) return;
  if (initSignature(reference) !== initSignature(candidate)) {
    throw new MergeError(
      "INIT_MISMATCH",
      `Init metadata in ${sourceName} does not match the first init segment`,
      {
        expected: initSignature(reference),
        actual: initSignature(candidate),
      },
    );
  }
}

function chooseSequenceSource(media, requested) {
  if (requested === "order") return "order";
  if (requested === "filename") return "filename";
  if (requested === "mfhd") return "mfhd";

  const filenameValues = media.map((entry) => entry.filenameIndex);
  if (filenameValues.every((value) => value !== null)) {
    return "filename";
  }

  const mfhdValues = media.map((entry) => entry.firstSequence);
  if (
    mfhdValues.every((value) => value !== null) &&
    new Set(mfhdValues).size === media.length
  ) {
    return "mfhd";
  }
  return "order";
}

function assignSourceIndices(media, strategy) {
  let ordered;
  if (strategy === "filename") {
    const missingNames = media.filter((entry) => entry.filenameIndex === null);
    if (missingNames.length > 0) {
      throw new MergeError(
        "MISSING_FILENAME_SEQUENCE",
        "Filename sequence mode requires a trailing segment number in every media filename",
        { files: missingNames.map((entry) => entry.sourceName) },
      );
    }
    ordered = [...media].sort((a, b) => a.filenameIndex - b.filenameIndex);
    for (const entry of ordered) entry.sourceIndex = entry.filenameIndex;
  } else if (strategy === "mfhd") {
    const missingSequences = media.filter((entry) => entry.firstSequence === null);
    if (missingSequences.length > 0) {
      throw new MergeError(
        "MISSING_MFHD_SEQUENCE",
        "mfhd sequence mode requires every media input to contain a moof/mfhd",
        { files: missingSequences.map((entry) => entry.sourceName) },
      );
    }
    ordered = [...media].sort((a, b) => a.firstSequence - b.firstSequence);
    for (const entry of ordered) entry.sourceIndex = entry.firstSequence;
  } else {
    ordered = [...media];
    ordered.forEach((entry, index) => {
      entry.sourceIndex = index + 1;
    });
  }
  return ordered;
}

function findDuplicates(ordered) {
  const duplicateIndices = [];
  const byIndex = new Map();
  for (const entry of ordered) {
    const previous = byIndex.get(entry.sourceIndex);
    if (previous) {
      duplicateIndices.push({
        sourceIndex: entry.sourceIndex,
        files: [previous.sourceName, entry.sourceName],
      });
    } else {
      byIndex.set(entry.sourceIndex, entry);
    }
  }

  const duplicateContent = [];
  const byHash = new Map();
  for (const entry of ordered) {
    const previous = byHash.get(entry.hash);
    if (previous) {
      duplicateContent.push({
        files: [previous.sourceName, entry.sourceName],
        sourceIndices: [previous.sourceIndex, entry.sourceIndex],
      });
    } else {
      byHash.set(entry.hash, entry);
    }
  }
  return { duplicateIndices, duplicateContent };
}

function findMissingIndices(ordered) {
  if (ordered.length === 0) return [];
  const present = new Set(ordered.map((entry) => entry.sourceIndex));
  const first = Math.min(...present);
  const last = Math.max(...present);
  const missing = [];
  for (let index = first; index <= last; index += 1) {
    if (!present.has(index)) missing.push(index);
  }
  return missing;
}

export async function readInputs(files, options = {}) {
  if (files.length === 0) {
    throw new MergeError("NO_INPUT", "No input files were provided");
  }
  const infos = [];
  for (const file of files) {
    const buffer = await readFile(file);
    infos.push(inspectMp4(buffer, file));
  }
  const withInit = infos.filter((info) => info.init);
  if (withInit.length === 0) {
    throw new MergeError("MISSING_MOOV", "No ftyp/moov init segment was found");
  }
  const referenceInit = withInit[0].init;
  for (const info of withInit.slice(1)) {
    validateInitConsistency(referenceInit, info.init, info.sourceName);
  }

  const media = infos
    .filter((info) => info.moofBoxes.length > 0)
    .map((info) => ({
      ...info,
      filenameIndex: trailingSequence(info.sourceName),
      firstSequence: firstMoofSequence(info),
    }));
  if (media.length === 0) {
    throw new MergeError("NO_MEDIA", "No moof/mdat media fragments were found");
  }
  const sequenceSource = chooseSequenceSource(media, options.sequenceFrom ?? "auto");
  let ordered;
  try {
    ordered = assignSourceIndices(media, sequenceSource);
  } catch (error) {
    if (
      error instanceof MergeError &&
      options.sequenceFrom === undefined &&
      error.code === "MISSING_FILENAME_SEQUENCE"
    ) {
      ordered = assignSourceIndices(media, "order");
      return { infos, init: referenceInit, media: ordered, sequenceSource: "order" };
    }
    throw error;
  }

  const duplicates = findDuplicates(ordered);
  const missing = findMissingIndices(ordered);
  return {
    infos,
    init: referenceInit,
    media: ordered,
    sequenceSource,
    duplicates,
    missing,
  };
}

function assertIntegrity(inputs, options) {
  const { duplicateIndices, duplicateContent } = inputs.duplicates;
  if (duplicateIndices.length > 0 || duplicateContent.length > 0) {
    throw new MergeError(
      "DUPLICATE_SEGMENTS",
      "Duplicate media segments were found; remove them before merging",
      { duplicateIndices, duplicateContent },
    );
  }
  if (inputs.missing.length > 0 && !options.allowGaps) {
    throw new MergeError(
      "MISSING_SEGMENTS",
      `Missing source sequence numbers: ${inputs.missing.join(", ")}`,
      {
        missing: inputs.missing,
        sequenceSource: inputs.sequenceSource,
      },
    );
  }
}

function patchTfdt(buffer, tfdtBox, decodeTime, trackId) {
  const { version } = readFullBox(buffer, tfdtBox);
  if (version === 0) {
    if (decodeTime > 0xffffffffn) {
      throw new MergeError(
        "TFDT_OVERFLOW",
        `Track ${trackId} exceeds 32-bit tfdt; version upgrade is not supported in-place`,
      );
    }
    buffer.writeUInt32BE(Number(decodeTime), tfdtBox.dataStart + 4);
  } else if (version === 1) {
    writeUInt64BE(buffer, decodeTime, tfdtBox.dataStart + 4);
  } else {
    throw new Error(`Unsupported tfdt version ${version}`);
  }
}

function rewriteMoof(sourceBuffer, moofBox, outputSequence, decodeTimes) {
  const clone = Buffer.from(sliceBox(sourceBuffer, moofBox));
  const root = {
    dataStart: moofBox.headerSize,
    dataEnd: clone.length,
  };
  const children = readBoxes(clone, root.dataStart, root.dataEnd);
  const mfhd = findBox(children, "mfhd");
  if (!mfhd) throw new Error("Cannot rewrite moof without mfhd");
  clone.writeUInt32BE(outputSequence, mfhd.dataStart + 4);

  for (const traf of children.filter((box) => box.type === "traf")) {
    const trafChildren = childBoxes(clone, traf);
    const tfhd = findBox(trafChildren, "tfhd");
    if (!tfhd) throw new Error("Cannot rewrite traf without tfhd");
    const trackId = clone.readUInt32BE(tfhd.dataStart + 4);
    const tfdt = findBox(trafChildren, "tfdt");
    if (!tfdt) {
      throw new MergeError(
        "MISSING_TFDT",
        `Track ${trackId} fragment has no tfdt; cannot rebase its decode time safely`,
      );
    }
    patchTfdt(clone, tfdt, decodeTimes.get(trackId), trackId);
  }
  return clone;
}

function mediaBoxes(entry) {
  const kept = entry.boxes.filter((box) => !DROPPED_TOP_LEVEL.has(box.type));
  const moofStarts = new Set(entry.moofBoxes.map((box) => box.start));
  return kept.map((box) => ({ box, isMoof: moofStarts.has(box.start) }));
}

function makeFtyp() {
  const buffer = Buffer.alloc(28);
  buffer.writeUInt32BE(28, 0);
  buffer.write("ftyp", 4, "latin1");
  buffer.write("isom", 8, "latin1");
  buffer.writeUInt32BE(512, 12);
  buffer.write("isom", 16, "latin1");
  buffer.write("iso6", 20, "latin1");
  buffer.write("mp41", 24, "latin1");
  return buffer;
}

function appendTrackTimeline(track, init, fragment, decodeStart, stats) {
  const handler = init.tracks.get(track.trackId)?.handler ?? "unknown";
  const keyframeTimes = track.keyframes.map((keyframe) => {
    const ticks = decodeStart + keyframe.presentationTimeTicks;
    return Number(ticks) / track.timescale;
  });
  const trackStats = stats.byTrack.get(track.trackId) ?? {
    trackId: track.trackId,
    handler,
    timescale: track.timescale,
    sampleCount: 0,
    durationSeconds: 0,
    keyframeStarts: [],
  };
  trackStats.sampleCount += track.sampleCount;
  trackStats.durationSeconds += track.durationSeconds;
  if (handler === "vide") trackStats.keyframeStarts.push(...keyframeTimes);
  stats.byTrack.set(track.trackId, trackStats);
  stats.sampleCount += track.sampleCount;
  if (handler === "vide") {
    stats.keyframeStarts.push(...keyframeTimes);
    fragment.keyframeTimes = (fragment.keyframeTimes ?? []).concat(keyframeTimes);
  }
}

export function mergeInputs(inputs, options = {}) {
  assertIntegrity(inputs, options);
  const initInfo = inputs.infos.find((info) => info.init) ?? null;
  const ftypChunks = initInfo?.ftypBox
    ? [sliceBox(initInfo.buffer, initInfo.ftypBox)]
    : [makeFtyp()];
  const moovChunks = [sliceBox(initInfo.buffer, initInfo.moovBox)];
  const decodeTimes = new Map();
  const outputChunks = [...ftypChunks, ...moovChunks];
  let outputSequence = 1;
  const segments = [];
  const trackTotals = new Map();
  const moofCounts = new Set();

  for (const entry of inputs.media) {
    const segment = {
      sourceName: entry.sourceName,
      sourceIndex: entry.sourceIndex,
      sequenceNumbers: [],
      sampleCount: 0,
      keyframeTimes: [],
      durationSeconds: 0,
      fragments: 0,
      tracks: [],
    };
    const stats = {
      sampleCount: 0,
      keyframeStarts: [],
      byTrack: new Map(),
    };
    let fragmentDuration = 0;

    for (const { box, isMoof } of mediaBoxes(entry)) {
      if (!isMoof) {
        outputChunks.push(sliceBox(entry.buffer, box));
        continue;
      }
      const fragment = parseMoof(entry.buffer, box, entry.init ?? inputs.init);
      const key = `${fragment.sequenceNumber}:${entry.hash}`;
      if (moofCounts.has(key)) {
        throw new MergeError(
          "DUPLICATE_FRAGMENT",
          `Duplicate moof sequence ${fragment.sequenceNumber} in ${entry.sourceName}`,
        );
      }
      moofCounts.add(key);

      const starts = new Map();
      for (const [trackId, track] of fragment.tracks) {
        const start = decodeTimes.get(trackId) ?? 0n;
        starts.set(trackId, start);
        appendTrackTimeline(track, inputs.init, fragment, start, stats);
        decodeTimes.set(trackId, start + track.durationTicks);
        const total = trackTotals.get(trackId) ?? {
          trackId,
          timescale: track.timescale,
          durationTicks: 0n,
        };
        total.durationTicks += track.durationTicks;
        trackTotals.set(trackId, total);
      }

      outputChunks.push(rewriteMoof(entry.buffer, box, outputSequence, starts));
      segment.sequenceNumbers.push(fragment.sequenceNumber);
      segment.sampleCount += fragment.sampleCount;
      segment.fragments += 1;
      fragmentDuration += fragment.durationSeconds;
      outputSequence += 1;
    }

    segment.durationSeconds = fragmentDuration;
    segment.keyframeTimes = stats.keyframeStarts;
    segment.tracks = [...stats.byTrack.values()];
    segments.push(segment);
  }

  const tracks = [...trackTotals.values()].map((track) => ({
    trackId: track.trackId,
    handler: inputs.init.tracks.get(track.trackId)?.handler ?? "unknown",
    timescale: track.timescale,
    durationSeconds: Number(track.durationTicks) / track.timescale,
  }));
  const durationSeconds = tracks.reduce(
    (maximum, track) => Math.max(maximum, track.durationSeconds),
    0,
  );

  return {
    buffer: Buffer.concat(outputChunks),
    segments,
    tracks,
    durationSeconds,
    sequenceSource: inputs.sequenceSource,
    missing: inputs.missing,
    outputSequenceCount: outputSequence - 1,
  };
}

export function verifyMerged(buffer) {
  const info = inspectMp4(buffer, "<merged output>");
  if (!info.init) throw new Error("Merged output has no moov");
  if (info.moofBoxes.length === 0) throw new Error("Merged output has no media fragments");
  const expected = new Map();
  const problems = [];
  let fragmentIndex = 0;

  for (const moofBox of info.moofBoxes) {
    fragmentIndex += 1;
    const fragment = parseMoof(buffer, moofBox, info.init);
    if (fragment.sequenceNumber !== fragmentIndex) {
      problems.push(
        `moof #${fragmentIndex} has mfhd sequence ${fragment.sequenceNumber}`,
      );
    }
    for (const [trackId, track] of fragment.tracks) {
      const decodeTime = track.baseDecodeTime ?? 0n;
      const wanted = expected.get(trackId) ?? 0n;
      if (decodeTime !== wanted) {
        problems.push(
          `track ${trackId} tfdt ${decodeTime} != expected ${wanted} in moof #${fragmentIndex}`,
        );
      }
      expected.set(trackId, decodeTime + track.durationTicks);
    }
  }

  if (problems.length > 0) {
    throw new MergeError(
      "OUTPUT_TIMELINE_INVALID",
      `Merged output timeline is discontinuous:\n${problems.slice(0, 10).join("\n")}`,
      { problems },
    );
  }
  return {
    fragmentCount: fragmentIndex,
    trackEnds: [...expected.entries()].map(([trackId, ticks]) => ({
      trackId,
      endTicks: ticks.toString(),
      durationSeconds: Number(ticks) / info.init.tracks.get(trackId).timescale,
    })),
  };
}
