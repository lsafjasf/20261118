// Headless-browser smoke test: loads the app, runs all three synthetic
// signals, switches analysis windows, and checks the rendered metrics.
// Run: node tests/e2e-smoke.cjs  (requires playwright-core + chromium)
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('/tmp/node_modules/playwright-core');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);
      fs.readFile(p, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const port = srv.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + port + '/');

  let failures = 0;
  async function check(name, fn) {
    const ok = await fn();
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name);
    if (!ok) failures++;
  }
  const text = id => page.textContent(id);

  // 1. sine with silence gap
  await page.click('#gen-sine');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('分析完成'));
  await check('正弦 积分响度 ≈ -20 LUFS', async () => {
    const v = parseFloat(await text('#m-integrated'));
    return Math.abs(v - -20.3) < 0.5;
  });
  await check('正弦 增益约 +4.3 dB', async () => {
    const t = await text('#m-gain');
    return t.includes('+4.') && t.includes('dB');
  });
  await check('正弦 无削波候选', async () => (await text('#m-clips')).includes('无'));

  // window switch updates the curve label and values
  await page.selectOption('#window-select', '3');
  await check('切换到 3s 窗口后标签更新', async () =>
    (await text('#m-window-label')).includes('3s'));

  // 2. impulses
  await page.click('#gen-impulse');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('分析完成'));
  await check('脉冲 真峰值 > 0 dBTP（采样间过冲）', async () => {
    const t = await text('#m-true-peak');
    return t.includes('+1.') || t.includes('+0.');
  });
  await check('脉冲 削波候选被标出', async () =>
    (await text('#m-clips')).includes('处削波候选'));

  // 3. asymmetric
  await page.click('#gen-asym');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('分析完成'));
  await check('不对称 左右真峰值分列', async () => {
    const t = await text('#m-true-peak');
    return t.includes('Ch1') && t.includes('Ch2') && t.includes('-14.');
  });

  // 4. export JSON produces a download
  const dl = page.waitForEvent('download', { timeout: 5000 });
  await page.click('#export-json');
  const download = await dl;
  await check('JSON 导出触发下载', async () =>
    (await download.suggestedFilename()).endsWith('_loudness-report.json'));

  await check('无页面脚本错误', async () => errors.length === 0);
  if (errors.length) console.log(errors);

  await page.screenshot({ path: path.join(ROOT, 'artifacts', 'app-screenshot.png'), fullPage: true });
  await browser.close();
  srv.close();
  console.log(failures === 0 ? 'E2E 全部通过' : failures + ' 项失败');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
