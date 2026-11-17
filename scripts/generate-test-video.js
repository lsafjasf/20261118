// Build the canonical 20-chapter test clip:
//   20 chapters x 6 frames @ 2fps -> 3s per chapter, 60s total, 120 VP9 frames
// The stripped ffmpeg shipped with Playwright lacks lavfi and chapter muxing,
// so a full static ffmpeg build is downloaded to test-output/tools when needed.
// As a self-check of the in-repo EBML stack, the encoded frames are parsed and
// re-muxed through src/webm-muxer.js as well (see FIXTURE_VARIANT).
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { findFullFfmpeg } from '../tests/lib/ffmpeg.js';
import { parseWebm } from '../src/webm-parser.js';
import { buildWebm } from '../src/webm-muxer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE_DIR = join(ROOT, 'tests', 'fixtures');
const OUTPUT_WEBM = join(FIXTURE_DIR, 'chapters-20.webm');
const EXPECTED_JSON = join(FIXTURE_DIR, 'chapters-20.expected.json');

export const WIDTH = 320;
export const HEIGHT = 180;
export const FPS = 2;
export const CHAPTER_COUNT = 20;
export const FRAMES_PER_CHAPTER = 6;
export const CHAPTER_DURATION_MS = (FRAMES_PER_CHAPTER / FPS) * 1000; // 3000

function buildMetadataFile(chapters) {
  const lines = [';FFMETADATA1'];
  for (const chapter of chapters) {
    lines.push('[CHAPTER]');
    lines.push('TIMEBASE=1/1000');
    lines.push(`START=${chapter.startMs}`);
    // END is inclusive of the millisecond before the next chapter boundary.
    lines.push(`END=${chapter.endMs - 1}`);
    lines.push(`title=${chapter.title}`);
  }
  return `${lines.join('\n')}\n`;
}

// One lavfi source per chapter (testsrc2 with a distinct hue), concatenated
// in order. testsrc2's on-screen counter and the hue band let tests identify
// the chapter and frame each thumbnail came from.
function buildLavfiInputs() {
  const inputs = [];
  for (let index = 0; index < CHAPTER_COUNT; index++) {
    const hue = Math.round((index * 360) / CHAPTER_COUNT);
    inputs.push(
      `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${CHAPTER_DURATION_MS / 1000}` +
        `,hue=h=${hue}:s=1`
    );
  }
  return inputs;
}

function buildConcatFilter() {
  const labels = [];
  const parts = [];
  for (let index = 0; index < CHAPTER_COUNT; index++) {
    labels.push(`[${index}:v]`);
  }
  parts.push(`${labels.join('')}concat=n=${CHAPTER_COUNT}:v=1:a=0[outv]`);
  return parts.join(';');
}

async function encodeChapterWebm(workDir, metadataPath) {
  const ffmpeg = findFullFfmpeg();
  const outputPath = join(workDir, 'chapters-20.ffmpeg.webm');
  const lavfiInputs = buildLavfiInputs();
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of lavfiInputs) {
    args.push('-f', 'lavfi', '-i', input);
  }
  args.push(
    '-i', metadataPath,
    '-filter_complex', buildConcatFilter(),
    '-map', '[outv]',
    '-map_chapters', String(CHAPTER_COUNT),
    '-c:v', 'libvpx-vp9',
    '-g', '1',
    '-auto-alt-ref', '0',
    '-keyint_min', '1',
    '-deadline', 'realtime',
    '-cpu-used', '8',
    '-b:v', '2M',
    '-pix_fmt', 'yuv420p',
    outputPath
  );
  const child = spawn(
    ffmpeg,
    args,
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );

  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  return outputPath;
}

// Re-mux encoded frames through the in-repo EBML writer so the test suite also
// exercises src/webm-muxer.js end to end. Chapter end times become exclusive.
function remuxWithInRepoMuxer(parsed, chapters) {
  const frames = parsed.frames.map((frame, index) => ({
    ptsMs: frame.ptsMs,
    data: new Uint8Array(frame.data),
    keyframe: frame.keyframe
  }));
  return buildWebm({
    width: parsed.tracks[0]?.width ?? WIDTH,
    height: parsed.tracks[0]?.height ?? HEIGHT,
    frames,
    chapters: chapters.map((chapter) => ({ ...chapter }))
  });
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function generateFixture() {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const workDir = join(ROOT, 'test-output', 'fixture-work');
  await mkdir(workDir, { recursive: true });

  const chapters = Array.from({ length: CHAPTER_COUNT }, (_, index) => ({
    uid: index + 1,
    startMs: index * CHAPTER_DURATION_MS,
    endMs: (index + 1) * CHAPTER_DURATION_MS,
    title: `Chapter ${String(index + 1).padStart(2, '0')}`
  }));
  const metadataPath = join(workDir, 'chapters.txt');
  await writeFile(metadataPath, buildMetadataFile(chapters));

  const ffmpegWebmPath = await encodeChapterWebm(workDir, metadataPath);
  const rawBuffer = await readFile(ffmpegWebmPath);
  const parsed = parseWebm(rawBuffer.buffer.slice(rawBuffer.byteOffset, rawBuffer.byteOffset + rawBuffer.byteLength));

  if (parsed.frames.length !== CHAPTER_COUNT * FRAMES_PER_CHAPTER) {
    throw new Error(`expected ${CHAPTER_COUNT * FRAMES_PER_CHAPTER} frames, got ${parsed.frames.length}`);
  }
  if (!parsed.frames.every((frame) => frame.keyframe)) {
    throw new Error('fixture requires all-keyframe VP9 output');
  }
  if (parsed.chapters.length !== CHAPTER_COUNT) {
    throw new Error(`expected ${CHAPTER_COUNT} chapters, ffmpeg wrote ${parsed.chapters.length}`);
  }

  // Canonical fixture uses the in-repo muxer so both read and write paths are
  // covered; the ffmpeg-produced file is kept alongside for cross-validation.
  const finalBytes = remuxWithInRepoMuxer(parsed, chapters);
  await writeFile(OUTPUT_WEBM, finalBytes);
  const crossCheckPath = join(FIXTURE_DIR, 'chapters-20.ffmpeg.webm');
  await writeFile(crossCheckPath, rawBuffer);
  if (!(await pathExists(OUTPUT_WEBM))) throw new Error('fixture write failed');

  const expected = {
    width: WIDTH,
    height: HEIGHT,
    fps: FPS,
    chapterCount: CHAPTER_COUNT,
    framesPerChapter: FRAMES_PER_CHAPTER,
    chapterDurationMs: CHAPTER_DURATION_MS,
    totalDurationMs: CHAPTER_COUNT * CHAPTER_DURATION_MS,
    totalFrames: CHAPTER_COUNT * FRAMES_PER_CHAPTER,
    chapters: chapters.map((chapter) => ({
      ...chapter,
      framePtsMs: Array.from(
        { length: FRAMES_PER_CHAPTER },
        (_, frameIndex) => chapter.startMs + (frameIndex * 1000) / FPS
      )
    }))
  };
  await writeFile(EXPECTED_JSON, `${JSON.stringify(expected, null, 2)}\n`);
  await rm(workDir, { recursive: true, force: true });

  return {
    outputWebm: OUTPUT_WEBM,
    crossCheckWebm: crossCheckPath,
    expectedJson: EXPECTED_JSON,
    expected
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await generateFixture();
  console.log(`wrote ${result.outputWebm}`);
  console.log(`wrote ${result.expectedJson}`);
}
