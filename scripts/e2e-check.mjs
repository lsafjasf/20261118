// End-to-end verification without a browser: decode every MP4 to raw I420
// with ffmpeg, then run the exact same block-hash + timeline pipeline used
// by the WebCodecs UI. Proves pixel damage vs metadata-only differences.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { parseMp4 } from '../src/mp4.js';
import { diffByteRuns, buildTimeline } from '../src/compare.js';
import { hashRawI420, i420FrameSize } from '../src/raw420.js';
import { buildReport, reportToJson } from '../src/report.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fixtureDir = resolve(root, 'fixtures');
const workDir = resolve(root, 'artifacts', 'e2e-tmp');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const WIDTH = 320;
const HEIGHT = 240;
const BLOCK = 16;

function decodeToRaw(mp4Path, outPath) {
  execFileSync(ffmpegPath, [
    '-y',
    '-err_detect', 'ignore_err',
    '-flags2', '+chunks',
    '-i', mp4Path,
    '-pix_fmt', 'yuv420p',
    '-f', 'rawvideo',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

const scenarios = [
  { file: 'corrupt-keyframe.mp4', label: 'keyframe', expectVerdict: 'pixel-damage' },
  { file: 'corrupt-pframe.mp4', label: 'pframe', expectVerdict: 'pixel-damage' },
  { file: 'corrupt-metadata.mp4', label: 'metadata', expectVerdict: 'metadata-only' },
];

const sourcePath = resolve(fixtureDir, 'source.mp4');
const sourceRaw = resolve(workDir, 'source.yuv');
decodeToRaw(sourcePath, sourceRaw);
const sourceBytes = readFileSync(sourcePath);
const sourceMp4 = parseMp4(sourceBytes);
const referenceHashes = hashRawI420(
  readFileSync(sourceRaw), WIDTH, HEIGHT, BLOCK, sourceMp4.samples,
);

const results = [];
for (const scenario of scenarios) {
  const candidatePath = resolve(fixtureDir, scenario.file);
  const rawPath = resolve(workDir, `${scenario.label}.yuv`);
  decodeToRaw(candidatePath, rawPath);
  const candidateBytes = readFileSync(candidatePath);
  const candidateMp4 = parseMp4(candidateBytes);
  const candidateHashes = hashRawI420(
    readFileSync(rawPath), WIDTH, HEIGHT, BLOCK, candidateMp4.samples,
  );
  const runs = diffByteRuns(sourceBytes, candidateBytes);
  const timeline = buildTimeline(referenceHashes, candidateHashes, candidateMp4, runs);

  const report = buildReport({
    referenceName: 'source.mp4',
    candidateName: scenario.file,
    scenario: scenario.label,
    blockSize: BLOCK,
    timeline,
    referenceMeta: {
      byteLength: sourceBytes.length,
      sampleCount: sourceMp4.sampleCount,
      timescale: sourceMp4.timescale,
    },
    candidateMeta: {
      byteLength: candidateBytes.length,
      sampleCount: candidateMp4.sampleCount,
      timescale: candidateMp4.timescale,
    },
    decodeErrors: [],
  });
  writeFileSync(
    resolve(root, 'artifacts', `report-${scenario.label}.json`),
    reportToJson(report),
  );
  results.push({ scenario, timeline, rawLength: readFileSync(rawPath).length });
}

const frameSize = i420FrameSize(WIDTH, HEIGHT);
for (const result of results) {
  const { timeline, scenario } = result;
  const summary = {
    scenario: scenario.label,
    verdict: timeline.verdict,
    expected: scenario.expectVerdict,
    pixelDifferentFrames: timeline.totals.pixelDifferent,
    sampleRuns: timeline.totals.sampleRuns,
    metadataOrContainerRuns:
      timeline.totals.metadataRuns + timeline.totals.containerRuns,
    firstDamagedFrame: timeline.frames.find((f) => f.status === 'pixels-differ')?.frameIndex ?? null,
  };
  console.log(JSON.stringify(summary));
  if (timeline.verdict !== scenario.expectVerdict) {
    throw new Error(`verdict mismatch for ${scenario.label}`);
  }
}
console.log('raw frame size check:', frameSize, 'bytes/frame,', referenceHashes.length, 'frames');
rmSync(workDir, { recursive: true, force: true });
