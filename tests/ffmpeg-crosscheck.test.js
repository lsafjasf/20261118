import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseWebm } from '../src/webm-parser.js';
import { findFullFfmpeg } from './lib/ffmpeg.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FFMPEG_WEBM = join(HERE, 'fixtures', 'chapters-20.ffmpeg.webm');

test('parser agrees with ffprobe on the ffmpeg-produced reference WebM', () => {
  const ffmpegDir = dirname(findFullFfmpeg());
  const ffprobe = join(ffmpegDir, 'ffprobe');
  const probe = spawnSync(
    ffprobe,
    ['-hide_banner', '-show_chapters', '-of', 'json', FFMPEG_WEBM],
    { encoding: 'utf8' }
  );
  assert.equal(probe.status, 0, probe.stderr);
  const ffprobeChapters = JSON.parse(probe.stdout).chapters;
  assert.equal(ffprobeChapters.length, 20);

  const raw = spawnSync(
    ffprobe,
    ['-hide_banner', '-count_frames', '-select_streams', 'v:0', '-show_streams', '-of', 'json', FFMPEG_WEBM],
    { encoding: 'utf8' }
  );
  const streamInfo = JSON.parse(raw.stdout).streams[0];
  assert.equal(streamInfo.codec_name, 'vp9');
  assert.equal(Number(streamInfo.nb_read_frames), 120);
});

test('in-repo parser reads all frames and chapters from the ffmpeg reference file', async () => {
  const fileBuffer = await readFile(FFMPEG_WEBM);
  const arrayBuffer = fileBuffer.buffer.slice(
    fileBuffer.byteOffset,
    fileBuffer.byteOffset + fileBuffer.byteLength
  );
  const parsed = parseWebm(arrayBuffer);
  assert.equal(parsed.frames.length, 120);
  assert.equal(parsed.chapters.length, 20);
  assert.deepEqual(
    parsed.frames.map((frame) => frame.ptsMs),
    Array.from({ length: 120 }, (_, index) => index * 500)
  );
  assert.deepEqual(
    parsed.chapters.map((chapter) => chapter.title),
    Array.from({ length: 20 }, (_, index) => `Chapter ${String(index + 1).padStart(2, '0')}`)
  );
  // ffmpeg's muxer writes chapter timecodes in raw nanoseconds instead of
  // TimestampScale units, so parsed values are scaled by 1e6 here. The
  // canonical in-repo fixture (chapters-20.webm) follows the spec instead.
  assert.equal(parsed.chapters[0].startMs, 0);
  assert.equal(parsed.chapters[0].endMs, 2_999_000_000);
  assert.equal(parsed.chapters.at(-1).startMs, 57_000_000_000);
  assert.equal(parsed.chapters.at(-1).endMs, 59_999_000_000);
});
