/* Headless browser smoke test for the interactive viewer.
 * Start src/serve.py first, then: node tests/viewer_smoke.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8000/viewer.html';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 2400 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('#cards .card').length === 4);
await page.waitForFunction(() => window.__audioReady && window.__audioReady.hasSamples,
  { timeout: 60000 });

const cardText = await page.locator('#cards').innerText();
const checks = [];
function check(name, cond) {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}
const ready = await page.evaluate(() => window.__audioReady);
check('audio decoded at native 24 kHz (no resample)', ready.ctxRate === 24000 && ready.samplesLen === 14400000);

check('cards show 0.00 dBFS peak at 250 s', /0\.00 dBFS/.test(cardText) && /250\.0 s/.test(cardText));
check('cards show 40.0 s silence', /40\.0 s/.test(cardText));
check('cards show highest loudness LUFS', /LUFS/.test(cardText));
check('map canvas has drawn content', await page.evaluate(() => {
  const c = document.getElementById('map');
  return c.width > 0 && c.getContext('2d').getImageData(0, 0, c.width, c.height).data.some((v) => v !== 0);
}));
check('region table has rows', (await page.locator('tr.region').count()) >= 8);
check('strategy text mentions 50% overlap', (await page.locator('#strategy').innerText()).includes('50% 重叠'));

// Drag the local window and re-analyze; global time must be preserved.
await page.selectOption('#winStart', '120').catch(() => {});
await page.evaluate(() => {
  const s = document.getElementById('winStart');
  s.value = '120';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('winLen').value = '30';
  document.getElementById('winLen').dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#reanalyze');
await page.waitForFunction(() => document.getElementById('reanalyzeNote').textContent.includes('局部重分析完成'));
const note = await page.locator('#reanalyzeNote').innerText();
check('local reanalysis first frame stays global ~120 s', /120\.00 s/.test(note));
check('local reanalysis reports window silence/loudness', /最高响度/.test(note) && /静音/.test(note));

// Audition: clicking the zoom canvas schedules playback without time reset.
await page.evaluate(() => document.getElementById('zoom').getBoundingClientRect());
const box = await page.locator('#zoom').boundingBox();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
await page.waitForTimeout(200);
check('click schedules audition at global time', /t=/.test(await page.locator('#playReadout').innerText()));

if (errors.length) {
  console.log('\nBrowser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
}
if (checks.some((c) => !c.ok)) process.exitCode = 1;
await browser.close();
console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nAll viewer smoke checks passed.');
