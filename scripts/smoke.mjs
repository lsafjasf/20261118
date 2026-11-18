// Quick smoke test: record ~3s, pause/resume once, stop, download, parse.
import { chromium } from 'playwright';
import { createStaticServer } from '../server.mjs';
import { parseWebm } from '../js/ebml.js';
import { readFile } from 'node:fs/promises';

const server = await createStaticServer(8932);
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text());
});
await page.goto('http://localhost:8932/');
await page.waitForTimeout(500);

await page.click('#btn-start');
await page.waitForTimeout(2500);
await page.click('#btn-pause');
await page.waitForTimeout(800);
await page.click('#btn-resume');
await page.waitForTimeout(1500);
await page.click('#btn-stop');
await page.waitForTimeout(1000);

const stats = await page.evaluate(() => window.__recorder.getStats());
console.log('stats:', JSON.stringify(stats, null, 1));

const downloadPromise = page.waitForEvent('download');
await page.click('#btn-download');
const download = await downloadPromise;
const path = '/tmp/smoke.webm';
await download.saveAs(path);

const parsed = parseWebm(await readFile(path));
console.log('tracks:', JSON.stringify(parsed.tracks));
console.log('videoBlocks:', parsed.videoBlocks, 'audioBlocks:', parsed.audioBlocks);
console.log('trackStats:', JSON.stringify(parsed.trackStats, null, 1));
console.log('durationMs:', parsed.durationMs);

await browser.close();
server.close();
