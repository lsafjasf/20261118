// Timeline comparison: frame-hash diffs + source byte-range localization.

import { classifyOffset } from './mp4.js';
import { diffBlockGrids } from './hash.js';

export function diffByteRuns(referenceBytes, candidateBytes) {
  const length = Math.min(referenceBytes.length, candidateBytes.length);
  const runs = [];
  let start = -1;
  for (let offset = 0; offset < length; offset += 1) {
    const differs = referenceBytes[offset] !== candidateBytes[offset];
    if (differs && start === -1) start = offset;
    if (!differs && start !== -1) {
      runs.push({ start, end: offset });
      start = -1;
    }
  }
  if (start !== -1) runs.push({ start, end: length });
  return runs;
}

export function classifyRun(mp4, run) {
  const first = classifyOffset(mp4, run.start);
  const last = classifyOffset(mp4, run.end - 1);
  if (first.kind === 'sample' && last.kind === 'sample' &&
      first.sampleIndex === last.sampleIndex) {
    const sample = mp4.samples[first.sampleIndex];
    return {
      ...run,
      kind: 'sample',
      sampleIndex: sample.index,
      isKey: sample.isKey,
      frameType: sample.isKey ? 'I' : 'P',
      sampleByteRange: sample.byteRange,
    };
  }
  if (first.kind === 'metadata' || last.kind === 'metadata') {
    return { ...run, kind: 'metadata', region: 'moov' };
  }
  return { ...run, kind: 'container', region: first.region || 'unknown' };
}

export function classifyAllRuns(mp4, runs) {
  return runs.map((run) => classifyRun(mp4, run));
}

export function compareFramePair(referenceFrameHash, candidateFrameHash) {
  const changedBlocks = diffBlockGrids(referenceFrameHash, candidateFrameHash);
  return {
    match: changedBlocks.length === 0,
    changedBlockCount: changedBlocks.length,
    changedBlocks,
    planes: summarizePlanes(changedBlocks),
  };
}

function summarizePlanes(changedBlocks) {
  const summary = { Y: 0, U: 0, V: 0 };
  for (const block of changedBlocks) summary[block.plane] += 1;
  return summary;
}

// frameHashes: [{ frameIndex, pts, blockHash }] for both files, keyed by index.
export function buildTimeline(referenceHashes, candidateHashes, mp4, runs) {
  const runDetails = classifyAllRuns(mp4, runs);
  const affectedSamples = new Set(
    runDetails.filter((r) => r.kind === 'sample').map((r) => r.sampleIndex),
  );
  const sampleRuns = runDetails.filter((run) => run.kind === 'sample');
  const frames = referenceHashes.map((referenceHash) => {
    const candidateHash = candidateHashes.find(
      (item) => item.frameIndex === referenceHash.frameIndex,
    );
    if (!candidateHash || candidateHash.blockHash === null) {
      const sampleIndex = referenceHash.sampleIndex ?? referenceHash.frameIndex;
      return {
        frameIndex: referenceHash.frameIndex,
        pts: referenceHash.pts,
        sampleIndex,
        status: 'missing',
        changedBlockCount: 0,
        changedBlocks: [],
        planes: { Y: 0, U: 0, V: 0 },
        // A fatal slice error invalidates the whole GOP until the next IDR,
        // so every missing frame is attributed to the root sample run.
        linkedRuns: sampleRuns,
        sampleMutated: affectedSamples.has(sampleIndex),
      };
    }
    const pair = compareFramePair(referenceHash.blockHash, candidateHash.blockHash);
    const sampleIndex = referenceHash.sampleIndex ?? referenceHash.frameIndex;
    const linkedRuns = runDetails.filter((run) =>
      run.kind === 'sample' && run.sampleIndex === sampleIndex);
    return {
      frameIndex: referenceHash.frameIndex,
      pts: referenceHash.pts,
      sampleIndex,
      ...pair,
      status: pair.match ? 'match' : 'pixels-differ',
      linkedRuns,
      sampleMutated: affectedSamples.has(sampleIndex),
    };
  });

  const pixelDiffs = frames.filter((f) => f.status === 'pixels-differ');
  const missingFrames = frames.filter((f) => f.status === 'missing');
  const touchesSamples = runDetails.some((run) => run.kind === 'sample');
  const metadataOnly = runDetails.length > 0 &&
    pixelDiffs.length === 0 &&
    missingFrames.length === 0 &&
    !touchesSamples;
  return {
    frames,
    byteRuns: runDetails,
    totals: {
      frames: frames.length,
      matching: frames.filter((f) => f.status === 'match').length,
      pixelDifferent: pixelDiffs.length,
      missing: frames.filter((f) => f.status === 'missing').length,
      sampleRuns: runDetails.filter((r) => r.kind === 'sample').length,
      metadataRuns: runDetails.filter((r) => r.kind === 'metadata').length,
      containerRuns: runDetails.filter((r) => r.kind === 'container').length,
    },
    verdict: metadataOnly
      ? 'metadata-only'
      : (pixelDiffs.length > 0 || missingFrames.length > 0)
        ? 'pixel-damage'
        : 'identical',
  };
}
