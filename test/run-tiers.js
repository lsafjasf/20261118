// End-to-end test: runs the receiver under artificial delay/reorder for all
// three buffer tiers and checks the experiment's two key properties:
//   - low-latency tier: no burst of stale frames (late decodes ~ 0)
//   - stable tier: reorder buffer stays bounded (frame cap + byte cap)
// Usage: node test/run-tiers.js
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { launchBrowser, waitForFlag } from '../tools/browser.js';
const BASE = 'http://127.0.0.1:8787';
const DURATION = 12000;
const IMPAIRMENT = { jitter: 150, spike: 400, spikeProb: 5 }; // ms, ms, %

function startServer() {
  const child = spawn('node', ['server/index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`[server!] ${d}`));
  return child;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/cert-hash`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

async function ensureMedia(browser) {
  if (existsSync('media/store.json')) return;
  console.log('== no media store, capturing synthetic media ==');
  const page = await browser.newPage();
  await page.goto(`${BASE}/capture.html`);
  const ok = await waitForFlag(page, '__done', 180000);
  await page.close();
  if (!ok) throw new Error('media capture failed');
}

async function runTier(browser, tier) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log(`[${tier} pageerror]`, err.message));
  page.on('console', (msg) => console.log(`[${tier}]`, msg.text()));
  const q = new URLSearchParams({
    auto: '1',
    tier,
    jitter: String(IMPAIRMENT.jitter),
    spike: String(IMPAIRMENT.spike),
    spikeProb: String(IMPAIRMENT.spikeProb),
    duration: String(DURATION),
  });
  await page.goto(`${BASE}/?${q}`);
  await page.waitForFunction('window.__result !== undefined', {
    timeout: DURATION + 60000,
  });
  const result = await page.evaluate('window.__result');
  await page.close();
  return result;
}

const checks = [];
function check(name, cond, detail) {
  checks.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`);
}

function summarize(tier, r) {
  const v = r.video;
  const a = r.audio;
  console.log(
    `\n[${tier}] buffer=${r.config.bufferMs}ms\n` +
      `  video: recv=${v.received} emitted=${v.emitted} expired=${v.expired} ` +
      `lateDecodes=${v.lateDecodes} maxBurst=${v.maxBurst} ` +
      `bufPeak=${v.maxBufferedFrames}/${v.capFrames}f ${v.maxBufferedBytes}B syncSkip=${v.syncSkipped}\n` +
      `  audio: recv=${a.received} emitted=${a.emitted} expired=${a.expired} ` +
      `lateDecodes=${a.lateDecodes} maxBurst=${a.maxBurst} ` +
      `bufPeak=${a.maxBufferedFrames}/${a.capFrames}f ${a.maxBufferedBytes}B\n` +
      `  heap: start=${(r.heap.start / 1048576).toFixed(1)}MB ` +
      `max=${(r.heap.max / 1048576).toFixed(1)}MB end=${(r.heap.end / 1048576).toFixed(1)}MB`
  );
}

const server = startServer();
let failed = false;
try {
  await waitForServer();
  const browser = await launchBrowser();
  try {
    await ensureMedia(browser);
    const results = {};
    for (const tier of ['low', 'mid', 'high']) {
      console.log(`\n== tier: ${tier} ==`);
      results[tier] = await runTier(browser, tier);
      if (results[tier].error) throw new Error(`${tier}: ${results[tier].error}`);
      summarize(tier, results[tier]);
    }
    const low = results.low;
    const high = results.high;
    console.log('\n== assertions ==');
    check(
      'low: no stale-frame burst (lateDecodes==0)',
      low.video.lateDecodes === 0 && low.audio.lateDecodes === 0,
      `video=${low.video.lateDecodes} audio=${low.audio.lateDecodes}`
    );
    check(
      'low: max frames emitted per tick <= 3',
      low.video.maxBurst <= 3 && low.audio.maxBurst <= 3,
      `video=${low.video.maxBurst} audio=${low.audio.maxBurst}`
    );
    check(
      'low: expiry path exercised (expired>0)',
      low.video.expired > 0 || low.audio.expired > 0,
      `video=${low.video.expired} audio=${low.audio.expired}`
    );
    check(
      'high: video buffer frames within cap',
      high.video.maxBufferedFrames <= high.video.capFrames,
      `${high.video.maxBufferedFrames} <= ${high.video.capFrames}`
    );
    check(
      'high: audio buffer frames within cap',
      high.audio.maxBufferedFrames <= high.audio.capFrames,
      `${high.audio.maxBufferedFrames} <= ${high.audio.capFrames}`
    );
    check(
      'high: buffered bytes bounded (<1MB)',
      high.video.maxBufferedBytes < 1_000_000 && high.audio.maxBufferedBytes < 1_000_000,
      `video=${high.video.maxBufferedBytes} audio=${high.audio.maxBufferedBytes}`
    );
    check(
      'high: JS heap growth bounded (<64MB)',
      high.heap.end - high.heap.start < 64 * 1048576,
      `growth=${((high.heap.end - high.heap.start) / 1048576).toFixed(1)}MB`
    );
    check(
      'high: stable tier expiry rate low (<25%)',
      high.video.expired < high.video.received * 0.25,
      `expired=${high.video.expired} received=${high.video.received}`
    );
    for (const [tier, r] of Object.entries(results)) {
      check(
        `${tier}: frames received and accounted for`,
        r.video.received > 0 && r.video.emitted + r.video.expired >= r.video.received - r.video.capFrames,
        `recv=${r.video.received} emitted=${r.video.emitted} expired=${r.video.expired}`
      );
    }
    failed = checks.some((c) => !c.ok);
  } finally {
    await browser.close();
  }
} finally {
  server.kill();
}
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: OK');
process.exit(failed ? 1 : 0);
