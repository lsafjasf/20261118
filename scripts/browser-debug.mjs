import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
};
const server = createServer(async (req, res) => {
  const relative = normalize(decodeURIComponent(new URL(req.url, 'http://localhost').pathname)).replaceAll(sep, '/');
  const publicCandidate = resolve(publicDir, `.${relative === '/' ? '/index.html' : relative}`);
  const rootCandidate = resolve(root, `.${relative}`);
  let filePath = rootCandidate;
  try {
    await readFile(publicCandidate);
    if (publicCandidate.startsWith(publicDir)) filePath = publicCandidate;
  } catch {}
  try {
    res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(await readFile(filePath));
  } catch {
    if (!res.headersSent) res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(8124, r));
const browser = await puppeteer.launch({
  executablePath: '/tmp/chrome-full/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message, e.stack));
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
  await page.goto('http://localhost:8124/', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.click('#loadFixtureBtn');
  await new Promise((r) => setTimeout(r, 500));
  const loaded = await page.evaluate(() => ({
    error: document.getElementById('errorBox').textContent,
  }));
  console.log('after load:', JSON.stringify(loaded));
  for (const scenario of ['gentlePframe', 'keyframe', 'pframe', 'metadata']) {
    await page.select('#scenario', scenario);
    await page.click('#runBtn');
    await page.waitForFunction(
      () => !document.getElementById('runBtn').disabled &&
        !document.getElementById('resultPanel').hidden,
      { timeout: 60000 },
    );
    const state = await page.evaluate(() => ({
      error: document.getElementById('errorBox').textContent,
      badge: document.querySelector('.verdict-badge')?.textContent,
      stats: [...document.querySelectorAll('.stat')].map((n) =>
        `${n.querySelector('.label').textContent}=${n.querySelector('.num').textContent}`),
      blockRows: document.querySelectorAll('#blockTable tbody tr').length,
      runRows: document.querySelectorAll('#runTable tbody tr').length,
    }));
    console.log(`[${scenario}]`, JSON.stringify(state));
    const detail = await page.evaluate(() => ({
      missing: window.__report.frames.filter((f) => f.status === 'missing').map((f) => f.frameIndex),
      diff: window.__report.frames.filter((f) => f.status === 'pixels-differ').map((f) => f.frameIndex),
      decodeErrors: window.__report.decodeErrors,
      runs: window.__report.byteRuns,
    }));
    console.log(`[${scenario}-detail]`, JSON.stringify(detail).slice(0, 700));
  }
} finally {
  await browser.close();
  server.close();
}
