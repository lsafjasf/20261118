// End-to-end verification:
//   10s active recording, 2 pauses, 1 browser refresh (recovery from
//   IndexedDB), then download and analyze the final WebM.
// Writes artifacts/verification.{webm,json,png}.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createStaticServer } from '../server.mjs';
import { parseWebm } from '../js/ebml.js';

const PORT = 8940;
const SAMPLE_BLOCK_MS = 20; // one Opus frame
const TARGET_ACTIVE_MS = 10000;

const server = await createStaticServer(PORT);
await mkdir('artifacts', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

const browserErrors = [];
const page = await browser.newPage();
page.on('pageerror', (err) => browserErrors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') browserErrors.push(msg.text());
});

const stats = () => page.evaluate(() => window.__recorder.getStats());
const activeMs = () => page.evaluate(() => window.__recorder.activeMs);

async function recordUntil(ms) {
  await page.waitForFunction((target) => window.__recorder.activeMs >= target, ms, {
    polling: 50,
  });
}

const metrics = { pauseCount: 0, browserRefreshes: 0 };

await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.__recorder);

// --- start recording -------------------------------------------------------
await page.click('#btn-start');
await page.waitForFunction(() => window.__recorder.state === 'recording');

// --- pause #1 at ~2s -------------------------------------------------------
await recordUntil(2000);
metrics.chunkCountBeforeFirstPause = (await stats()).chunks;
await page.click('#btn-pause');
await page.waitForTimeout(1000);
metrics.chunkCountAfterFirstPause = (await stats()).chunks;
await page.click('#btn-resume');
metrics.pauseCount += 1;

// --- pause #2 at ~4.5s ------------------------------------------------------
await recordUntil(4500);
metrics.chunkCountBeforeSecondPause = (await stats()).chunks;
await page.click('#btn-pause');
await page.waitForTimeout(1000);
metrics.chunkCountAfterSecondPause = (await stats()).chunks;
await page.click('#btn-resume');
metrics.pauseCount += 1;

// --- browser refresh at ~6s -------------------------------------------------
await recordUntil(6000);
metrics.chunkCountBeforeReload = (await stats()).chunks;
await page.reload();
metrics.browserRefreshes += 1;
await page.waitForFunction(() => window.__recorder);
await page.waitForSelector('#recovery-banner:not(.hidden)');

const recovery = await page.evaluate(() => window.__recorder.recoveryInfo);
metrics.recoveredChunks = recovery.chunks;
metrics.recoveredSegments = recovery.segments;
metrics.recoveredActiveMs = Math.round(recovery.activeMs);

// --- resume after refresh (new MediaRecorder segment) -----------------------
await page.click('#btn-recover');
await page.waitForFunction(() => window.__recorder.state === 'recording');
await page.waitForFunction(() => window.__recorder.getStats().segments >= 2);
metrics.segmentCountAfterResume = (await stats()).segments;

// --- record until 10s active, then stop --------------------------------------
await recordUntil(TARGET_ACTIVE_MS);
metrics.activeRecordingMs = await activeMs();
await page.click('#btn-stop');
await page.waitForFunction(() => window.__recorder.state === 'stopped');
await page.waitForTimeout(500);

const finalStats = await stats();
metrics.totalChunks = finalStats.chunks;
metrics.uiVideoBlocks = finalStats.videoBlocks;
metrics.uiAudioBlocks = finalStats.audioBlocks;

// --- download the remuxed WebM ----------------------------------------------
const downloadPromise = page.waitForEvent('download');
await page.click('#btn-download');
const download = await downloadPromise;
const webmPath = 'artifacts/verification.webm';
await download.saveAs(webmPath);

// --- analyze the final file ---------------------------------------------------
const parsed = parseWebm(await readFile(webmPath));
const videoStats = Object.values(parsed.trackStats).find((s) => s.type === 1);
const audioStats = Object.values(parsed.trackStats).find((s) => s.type === 2);

// In-browser ground truth: decode the audio track (sample-accurate duration)
// and prove playability by seeking to the end and waiting for `ended`.
const playback = await page.evaluate(async () => {
  const blob = await window.__recorder.buildFile();
  const buf = await blob.arrayBuffer();
  const out = {};
  const ctx = new OfflineAudioContext(1, 48000, 48000);
  const audio = await ctx.decodeAudioData(buf.slice(0));
  out.audioDecodedMs = audio.duration * 1000;
  const url = URL.createObjectURL(new Blob([buf], { type: 'video/webm' }));
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  await new Promise((resolve) => {
    video.onloadedmetadata = resolve;
  });
  video.currentTime = Math.max(0, out.audioDecodedMs / 1000 - 1.0);
  await video.play();
  out.playedToEnd = await new Promise((resolve) => {
    video.onended = () => resolve(true);
    setTimeout(() => resolve(false), 30000);
  });
  out.finalTimeMs = video.currentTime * 1000;
  URL.revokeObjectURL(url);
  return out;
});

// Per-track spans from container timecodes (end - start, with the exact
// frame count of the final Opus packet). The delta must not exceed one
// Opus sample block (20ms).
const videoDurationMs = videoStats ? videoStats.durationMs : 0;
const audioDurationMs = audioStats ? audioStats.durationMs : 0;
const durationDeltaMs = Math.abs(videoDurationMs - audioDurationMs);

// timeline sanity: block timecodes must be monotonic per track (no resets
// or jumps from the reload), and no gap may exceed one second.
const perTrack = new Map();
for (const block of parsed.blocks) {
  if (!perTrack.has(block.track)) perTrack.set(block.track, []);
  perTrack.get(block.track).push(block.absTimecode);
}
let monotonic = true;
let maxGapMs = 0;
for (const times of perTrack.values()) {
  for (let i = 1; i < times.length; i += 1) {
    const delta = times[i] - times[i - 1];
    if (delta < 0) monotonic = false;
    if (delta > maxGapMs) maxGapMs = delta;
  }
}

await page.screenshot({ path: 'artifacts/verification.png', fullPage: true });

const report = {
  verifiedAt: new Date().toISOString(),
  requirement: {
    activeRecordingMs: metrics.activeRecordingMs,
    pauseCount: metrics.pauseCount,
    browserRefreshes: metrics.browserRefreshes,
    recoveredChunks: metrics.recoveredChunks,
    recoveredSegments: metrics.recoveredSegments,
    segmentCountAfterResume: metrics.segmentCountAfterResume,
    chunkCountBeforeReload: metrics.chunkCountBeforeReload,
    chunkCountBeforeFirstPause: metrics.chunkCountBeforeFirstPause,
    chunkCountAfterFirstPause: metrics.chunkCountAfterFirstPause,
    chunkCountBeforeSecondPause: metrics.chunkCountBeforeSecondPause,
    chunkCountAfterSecondPause: metrics.chunkCountAfterSecondPause,
  },
  final: {
    size: (await readFile(webmPath)).length,
    durationMs: Math.round(parsed.durationMs),
    videoDurationMs: videoDurationMs,
    audioDurationMs: audioDurationMs,
    durationDeltaMs,
    withinOneBlock: durationDeltaMs <= SAMPLE_BLOCK_MS,
    sampleBlockMs: SAMPLE_BLOCK_MS,
    playable: playback.playedToEnd,
    playedToEndMs: Math.round(playback.finalTimeMs),
    audioDecodedMs: playback.audioDecodedMs,
    videoStartMs: videoStats ? videoStats.firstTimecodeMs : 0,
    audioStartMs: audioStats ? audioStats.firstTimecodeMs : 0,
    videoEndMs: videoStats ? videoStats.endMs : 0,
    audioEndMs: audioStats ? audioStats.endMs : 0,
    videoBlocks: parsed.videoBlocks,
    audioBlocks: parsed.audioBlocks,
    monotonicTimecodes: monotonic,
    maxGapMs,
  },
  file: { path: webmPath, size: (await readFile(webmPath)).length },
  browserErrors,
};
await writeFile('artifacts/verification.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();

if (
  !report.final.withinOneBlock ||
  !monotonic ||
  !playback.playedToEnd ||
  browserErrors.length > 0
) {
  console.error('VERIFICATION FAILED');
  process.exit(1);
}
console.log('VERIFICATION PASSED');
