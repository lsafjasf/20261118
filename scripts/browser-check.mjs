// Real-browser verification with WebCodecs via puppeteer-core + headless Chrome.
// Exercises the same UI pipeline a human user would click through.

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, normalize, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(root, 'public');
const executablePath = process.env.CHROME_BIN || '/tmp/chrome-full/chrome-linux64/chrome';
if (!existsSync(executablePath)) {
  throw new Error(`Chrome binary not found at ${executablePath}; set CHROME_BIN`);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = normalize(urlPath).replaceAll(sep, '/');
  const publicCandidate = resolve(publicDir, `.${relative === '/' ? '/index.html' : relative}`);
  const rootCandidate = resolve(root, `.${relative}`);
  let filePath = rootCandidate;
  try {
    await readFile(publicCandidate);
    if (publicCandidate.startsWith(publicDir)) filePath = publicCandidate;
  } catch { /* fall through to root */ }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404).end('not found');
  }
});

await new Promise((resolveServer) => server.listen(8123, resolveServer));

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('http://localhost:8123/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  const support = await page.evaluate(() => ({
    decoder: typeof VideoDecoder,
    frame: typeof VideoFrame,
  }));
  console.log('WebCodecs globals:', JSON.stringify(support));

  await page.click('#loadFixtureBtn');
  await page.waitForFunction(
    () => document.getElementById('errorBox').textContent === '' &&
      document.getElementById('runBtn').disabled === false,
  );
  await new Promise((r) => setTimeout(r, 300));

  const expectations = {
    gentlePframe: { verdict: 'pixel-damage', expectMissing: false, expectPixelDiff: true, expectSampleRuns: 1 },
    keyframe: { verdict: 'pixel-damage', expectMissing: true, expectPixelDiff: false, expectSampleRuns: 1 },
    pframe: { verdict: 'pixel-damage', expectMissing: true, expectPixelDiff: false, expectSampleRuns: 1 },
    metadata: { verdict: 'metadata-only', expectMissing: false, expectSampleRuns: 0 },
  };

  for (const [scenario, expected] of Object.entries(expectations)) {
    await page.select('#scenario', scenario);
    await page.click('#runBtn');
    await page.waitForFunction(
      () => !document.getElementById('runBtn').disabled &&
        !document.getElementById('resultPanel').hidden,
      { timeout: 60000 },
    );
    const result = await page.evaluate(() => {
      const badge = document.querySelector('.verdict-badge');
      const stats = [...document.querySelectorAll('.stat')].map((node) => ({
        label: node.querySelector('.label').textContent,
        value: node.querySelector('.num').textContent,
      }));
      const error = document.getElementById('errorBox').textContent;
      return { badge: badge && badge.textContent, stats, error };
    });
    console.log(`[${scenario}]`, JSON.stringify(result.badge));
    if (result.error) throw new Error(`UI error for ${scenario}: ${result.error}`);
    if (!result.badge.includes(expected.verdict === 'pixel-damage' ? '像素损坏' : '仅容器元数据')) {
      throw new Error(`unexpected verdict for ${scenario}: ${result.badge}`);
    }
    const statMap = Object.fromEntries(result.stats.map((entry) => [entry.label, entry.value]));
    const missing = Number(statMap['解码缺失帧']);
    const pixelDifferent = Number(statMap['像素差异帧']);
    const sampleRuns = Number(statMap['采样字节段']);
    if (expected.expectMissing && missing === 0) {
      throw new Error(`expected decoder-missing frames for ${scenario}, got 0`);
    }
    if (!expected.expectMissing && missing !== 0) {
      throw new Error(`metadata scenario must have no missing frames, got ${missing}`);
    }
    if (expected.expectPixelDiff && pixelDifferent === 0) {
      throw new Error(`expected block-level pixel differences for ${scenario}`);
    }
    if (expected.expectPixelDiff === false && expected.verdict === 'pixel-damage' &&
        missing === 0 && pixelDifferent > 0) {
      throw new Error(`strict scenario ${scenario} should surface GOP failure, not block diffs`);
    }
    if (sampleRuns !== expected.expectSampleRuns) {
      throw new Error(`sample run count mismatch for ${scenario}: ${sampleRuns}`);
    }
    console.log(`[${scenario}] stats:`, JSON.stringify(statMap));

    // Verify localization tables render (block hash rows or missing-frame note).
    if (expected.verdict === 'pixel-damage') {
      const tableCheck = await page.evaluate(() => {
        const rows = document.querySelectorAll('#blockTable tbody tr');
        const runRows = document.querySelectorAll('#runTable tbody tr');
        return {
          blockRows: rows.length,
          runRows: runRows.length,
          firstBlock: rows[0] ? rows[0].textContent.replace(/\s+/g, ' ').trim() : '',
          firstRun: runRows[0] ? runRows[0].textContent.replace(/\s+/g, ' ').trim() : '',
        };
      });
      console.log(`[${scenario}] tables:`, JSON.stringify(tableCheck));
      if (!tableCheck.blockRows || !tableCheck.runRows) {
        throw new Error(`missing localization tables for ${scenario}`);
      }
      if (!/\[\d+, \d+\)/.test(tableCheck.firstRun)) {
        throw new Error(`byte-range table not linked for ${scenario}`);
      }
    }
  }

  // Confirm the report payload contains hashes/ranges only, never pixel data.
  const reportShape = await page.evaluate(() => {
    const report = window.__report;
    const serialized = JSON.stringify(report);
    return {
      topKeys: Object.keys(report),
      frameKeys: Object.keys(report.frames[0]),
      containsDataUrl: serialized.includes('data:image'),
      containsBase64: /base64,/i.test(serialized),
      notice: report.contentNotice,
    };
  });
  console.log('report shape:', JSON.stringify(reportShape));
  if (reportShape.containsDataUrl || reportShape.containsBase64) {
    throw new Error('report unexpectedly embeds image/pixel payloads');
  }
  if (!reportShape.frameKeys.includes('changedBlocks') ||
      reportShape.frameKeys.includes('descriptor')) {
    throw new Error('report frame shape is wrong');
  }

  // Exercise both export renderers and assert they carry no pixel payloads.
  const exportCheck = await page.evaluate(async () => {
    const { reportToJson, reportToHtml } = await import('http://localhost:8123/src/report.js');
    const json = reportToJson(window.__report);
    const html = reportToHtml(window.__report);
    const parsed = JSON.parse(json);
    return {
      jsonLength: json.length,
      htmlLength: html.length,
      jsonHasFrames: Array.isArray(parsed.frames) && parsed.frames.length === 90,
      htmlHasNoImg: !/<img|data:image|canvas/i.test(html),
      htmlMentionsNotice: html.includes('No pixel data'),
      jsonNoDescriptor: !json.includes('descriptor'),
    };
  });
  console.log('export check:', JSON.stringify(exportCheck));
  if (!exportCheck.jsonHasFrames || !exportCheck.htmlHasNoImg ||
      !exportCheck.htmlMentionsNotice || !exportCheck.jsonNoDescriptor) {
    throw new Error('exported report failed content-safety checks');
  }

  if (consoleErrors.length) {
    throw new Error(`browser console errors: ${consoleErrors.join(' | ')}`);
  }
  console.log('browser verification passed with zero console errors');
} finally {
  await browser.close();
  server.close();
}
