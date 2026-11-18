// End-to-end test: run detection on the synthetic video and verify
//   1. the hard cut at ~4.0s is found (type "hard")
//   2. the fade out (~7-8s) is found and marked "gradual"
//   3. the fade in (~9-10s) is found and marked "gradual"
//   4. no boundaries inside the fast-motion segment (10.3s-14.8s)
//   5. no boundaries inside the slow segment A (0.3s-3.5s)
//   6. timeline correction: add + delete a boundary via UI clicks
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 8321;

function startServer() {
  const p = spawn('node', ['scripts/serve.mjs', String(PORT)], { stdio: 'pipe' });
  return new Promise((resolve) => {
    p.stdout.on('data', () => resolve(p));
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const server = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error:', m.text());
});

await page.goto(`http://127.0.0.1:${PORT}/index.html`);

// WebCodecs availability
const hasWebCodecs = await page.evaluate(() => typeof VideoDecoder !== 'undefined');
check('WebCodecs VideoDecoder available', hasWebCodecs);

await page.click('#demoBtn');
await page.waitForFunction(() => !document.getElementById('runBtn').disabled, null, { timeout: 15000 });
await page.click('#runBtn');
await page.waitForFunction(
  () => document.getElementById('status').textContent.includes('检测完成'),
  null,
  { timeout: 120000 },
);

const data = await page.evaluate(() => {
  const s = window.__shotApp;
  return {
    duration: s.duration,
    boundaries: s.boundaries.map((b) => ({ time: b.time, type: b.type, confidence: b.confidence })),
    shotCount: s.shots.length,
    thresholds: s.thresholds,
  };
});

console.log('detected boundaries:', JSON.stringify(data.boundaries, null, 1));
console.log('thresholds:', JSON.stringify(data.thresholds));

const near = (arr, t, tol, type) =>
  arr.some((b) => Math.abs(b.time - t) <= tol && (!type || b.type === type));
const inRange = (arr, a, b, type) =>
  arr.filter((x) => x.time >= a && x.time <= b && (!type || x.type === type));

check('finds hard cut @4.0s (±0.4s, type=hard)', near(data.boundaries, 4.0, 0.4, 'hard'),
  JSON.stringify(inRange(data.boundaries, 3.5, 4.5)));
check('finds fade-out as gradual in [6.8, 8.3]',
  inRange(data.boundaries, 6.8, 8.3, 'gradual').length > 0,
  JSON.stringify(inRange(data.boundaries, 6.5, 8.5)));
check('finds fade-in as gradual in [8.8, 10.3]',
  inRange(data.boundaries, 8.8, 10.3, 'gradual').length > 0,
  JSON.stringify(inRange(data.boundaries, 8.5, 10.5)));
check('no cuts in fast-motion segment [10.4, 14.8]',
  inRange(data.boundaries, 10.4, 14.8).length === 0,
  JSON.stringify(inRange(data.boundaries, 10.4, 14.8)));
check('no cuts in slow segment [0.3, 3.5]',
  inRange(data.boundaries, 0.3, 3.5).length === 0,
  JSON.stringify(inRange(data.boundaries, 0.3, 3.5)));
check('no cuts in moderate segment [4.4, 6.6]',
  inRange(data.boundaries, 4.4, 6.6).length === 0,
  JSON.stringify(inRange(data.boundaries, 4.4, 6.6)));
check('shot count is 4 (A / B / black / C)', data.shotCount === 4, `got ${data.shotCount}`);

// --- timeline correction: click to add a boundary, then delete it ---
const before = await page.evaluate(() => window.__shotApp.boundaries.length);
const box = await page.locator('#timeline').boundingBox();
// click at ~12.5s (inside fast-motion segment, currently no boundary)
const clickT = 12.5;
const clickX = box.x + (clickT / data.duration) * box.width;
await page.mouse.click(clickX, box.y + box.height / 2);
await page.waitForFunction(
  (n) => window.__shotApp.boundaries.length === n,
  before + 1,
  { timeout: 5000 },
);
const added = await page.evaluate((t) => {
  const s = window.__shotApp;
  const b = s.boundaries.find((x) => Math.abs(x.time - t) < 0.3);
  return b ? { time: b.time, type: b.type, selected: s.selected >= 0 } : null;
}, clickT);
check('click on timeline adds a boundary', !!added, JSON.stringify(added));

// toggle its type to gradual
await page.click('#toggleTypeBtn');
const toggled = await page.evaluate((t) => {
  const b = window.__shotApp.boundaries.find((x) => Math.abs(x.time - t) < 0.3);
  return b && b.type === 'gradual';
}, clickT);
check('toggle type hard->gradual works', toggled);

// delete it
await page.click('#deleteBtn');
await page.waitForFunction(
  (n) => window.__shotApp.boundaries.length === n,
  before,
  { timeout: 5000 },
);
check('delete boundary restores original count', true);

const finalShots = await page.evaluate(() => window.__shotApp.shots.length);
check('shots restored to 4 after delete', finalShots === 4, `got ${finalShots}`);

await page.screenshot({ path: 'artifacts/shot-boundary-result.png', fullPage: true });

// --- VP9-in-MP4 path: run the worker directly on the vp9 asset ---
const vp9 = await page.evaluate(async () => {
  const buf = await (await fetch('assets/test-video-vp9.mp4')).arrayBuffer();
  return new Promise((resolve) => {
    const w = new Worker('js/worker.js', { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.type === 'result') {
        resolve({
          ok: true,
          boundaries: e.data.boundaries.map((b) => ({ time: b.time, type: b.type })),
        });
        w.terminate();
      } else if (e.data.type === 'error') {
        resolve({ ok: false, error: e.data.message });
        w.terminate();
      }
    };
    w.postMessage({ type: 'detect', file: buf, options: { interval: 0.1, minShotLen: 0.5 } }, [buf]);
  });
});
check('vp9 path: detection completes', vp9.ok, vp9.error || '');
if (vp9.ok) {
  check('vp9 path: same 3 boundaries found',
    near(vp9.boundaries, 4.0, 0.4, 'hard') &&
    inRange(vp9.boundaries, 6.8, 8.3, 'gradual').length > 0 &&
    inRange(vp9.boundaries, 8.8, 10.3, 'gradual').length > 0 &&
    vp9.boundaries.length === 3,
    JSON.stringify(vp9.boundaries));
}

await browser.close();
server.kill();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
