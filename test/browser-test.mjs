// test/browser-test.mjs — end-to-end browser check with Playwright:
//  * captures UI screenshots (idle / running / mobile)
//  * renders 180 s of audio through the AudioWorklet (OfflineAudioContext
//    with suspend/resume pacing, since headless containers have no audio
//    output device) and samples telemetry every 30 s of audio
//  * asserts fixed latency, continuous sample counts and zero drift
//  * writes artifacts/browser-long-run.json
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const RUN_SECONDS = 180;
const SAMPLE_EVERY = 30;

const artifacts = new URL('../artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});

const failures = [];
function check(name, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  if (!pass) failures.push(name);
}

try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on('pageerror', (err) => console.error('page error:', err.message));
  await page.goto(`${base}/index.html`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: new URL('ui-idle.png', artifacts).pathname });

  await page.goto(`${base}/index.html?offline=${RUN_SECONDS}`);
  await page.click('#toggle');
  await page.waitForFunction(() => window.__gateTest?.stats().running, null,
    { timeout: 10000 });
  await page.waitForFunction(
    () => window.__gateTest.stats().telemetry?.frames > 500,
    null, { timeout: 30000 });
  await page.screenshot({ path: new URL('ui-running.png', artifacts).pathname });

  const stats0 = await page.evaluate(() => window.__gateTest.stats());
  check('worklet-running', stats0.running && stats0.telemetry?.frames > 0,
    `frames=${stats0.telemetry?.frames}`);
  check('levels-sane', stats0.telemetry && stats0.telemetry.inDb > -40
    && stats0.telemetry.outDb < stats0.telemetry.inDb,
    `in=${stats0.telemetry?.inDb?.toFixed(1)}dB out=${stats0.telemetry?.outDb?.toFixed(1)}dB`);

  // Wait for the full 180 s offline render to finish.
  await page.waitForFunction(() => window.__gateTest.state.finished === true,
    null, { timeout: RUN_SECONDS * 1000 });

  const finalStats = await page.evaluate(() => window.__gateTest.stats());
  // Sample the telemetry log at 30 s audio-time intervals.
  const samples = [];
  for (let at = 0; at <= RUN_SECONDS; at += SAMPLE_EVERY) {
    const entry = finalStats.log.reduce((best, e) =>
      (Math.abs(e.at - at) < Math.abs((best?.at ?? 1e9) - at) ? e : best), null);
    if (!entry) continue;
    const mm = String(Math.floor(entry.at / 60)).padStart(2, '0');
    const ss = String(Math.floor(entry.at % 60)).padStart(2, '0');
    samples.push({
      at,
      runtime: `${mm}:${ss}`,
      drift: `${entry.driftMs.toFixed(1)} ms`,
      frames: `${entry.frames.toLocaleString()} frames`,
      stability: finalStats.continuous ? '采样计数连续' : '采样计数断档',
      engine: entry.latencySamples === 1024 ? '处理中 · 固定延迟' : '延迟异常',
    });
    console.log(`t=${at}s drift=${entry.driftMs.toFixed(1)}ms frames=${entry.frames} fifo=${entry.fifoLevel}`);
  }
  const drifts = finalStats.log.map((e) => e.driftMs);
  const maxAbsDrift = Math.max(...drifts.map(Math.abs));
  const fifoOk = finalStats.log.every((e) => e.fifoLevel > 0 && e.fifoLevel <= 1024 + 256);
  const latencyOk = finalStats.log.every((e) => e.latencySamples === 1024);

  check('long-run-drift', maxAbsDrift < 1,
    `max |drift| ${maxAbsDrift.toFixed(2)} ms over ${RUN_SECONDS}s (expect < 1 ms)`);
  check('long-run-continuity', finalStats.continuous,
    finalStats.continuous ? 'sample counter continuous' : 'counter gaps detected');
  check('long-run-fifo-bounded', fifoOk,
    `fifo within (0, 1280] for ${finalStats.log.length} samples`);
  check('long-run-latency-fixed', latencyOk, 'latencySamples == 1024 throughout');

  await writeFile(new URL('browser-long-run.json', artifacts),
    `${JSON.stringify({ samples, errors: failures }, null, 2)}\n`);

  // Mobile layout screenshot (audio not required).
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`${base}/index.html`);
  await mobile.waitForTimeout(600);
  await mobile.screenshot({ path: new URL('ui-mobile.png', artifacts).pathname });
  await mobile.close();
  await page.close();
} finally {
  await browser.close();
  server.close();
}

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('browser long-run test passed');
