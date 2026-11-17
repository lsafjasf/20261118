// End-to-end verification in real headless Chromium with WebCodecs:
//   decode 90fps vs render 30fps (3x), bounded queue, drop-oldest policy.
// Checks: queue stays bounded, frames are dropped (not accumulated),
// playback stays smooth, and live VideoFrame count returns to 0 on stop.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = new URL('.', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };

const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

await page.goto(url);
await page.waitForFunction(() => window.player);

const RUN_MS = 6000;
await page.click('#startBtn');
const t0 = Date.now();
const samples = [];
while (Date.now() - t0 < RUN_MS) {
  await page.waitForTimeout(500);
  samples.push(await page.evaluate(() => window.player.stats()));
}
await page.click('#stopBtn');
await page.waitForTimeout(300); // let any in-flight tick settle
const final = await page.evaluate(() => window.player.stats());

await browser.close();
server.close();

const elapsedS = (Date.now() - t0) / 1000;
const maxQueue = Math.max(...samples.map((s) => s.queueLength));
const maxLive = Math.max(...samples.map((s) => s.liveFrames));
const last = samples[samples.length - 1];

console.log('--- sampled while running (last sample) ---');
console.log(last);
console.log(`--- final after stop ---`);
console.log(final);

// 1. Queue never exceeds capacity; live frames stay bounded (no pile-up).
assert.ok(maxQueue <= 8, `queue exceeded capacity: ${maxQueue}`);
assert.ok(maxLive <= 10, `live VideoFrames not bounded: ${maxLive}`);

// 2. Producer outran consumer 3x -> roughly 2/3 of frames dropped.
assert.ok(final.dropped > 0, 'no frames dropped');
const ratio = final.dropped / final.created;
assert.ok(ratio > 0.5 && ratio < 0.75, `drop ratio off: ${ratio.toFixed(2)}`);

// 3. Smooth playback: ~30fps rendered, no long stalls, no underruns.
const expected = 30 * elapsedS;
assert.ok(final.rendered > expected * 0.85, `too few frames rendered: ${final.rendered} vs ~${expected}`);
assert.ok(final.maxRenderGapMs < 150, `render stall: ${final.maxRenderGapMs}ms`);
assert.equal(final.underruns, 0, 'renderer starved despite 3x decode');

// 4. Bounded wait: queued frames are shown quickly, not seconds late.
assert.ok(final.avgWaitMs < 200, `avg wait too high: ${final.avgWaitMs}ms`);

// 5. Old frames released per policy, and zero leaks after stop.
assert.equal(final.liveFrames, 0, `leaked VideoFrames after stop: ${final.liveFrames}`);
assert.equal(final.created, final.closed, 'created != closed');

console.log('\nE2E verification: all checks passed');
