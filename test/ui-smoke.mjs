/**
 * 界面冒烟测试（无头浏览器）：
 * 1. 页面加载并渲染汇总、问题清单、明细表、时间线
 * 2. 默认必选故障（帧率写错 + 音频偏移）可见且可点击
 * 3. 点击问题卡片能定位到具体片段并弹出详情
 * 4. 故障开关切换后报告刷新
 * 运行：node test/ui-smoke.mjs
 */
import { chromium } from 'playwright-core';

const EXECUTABLE = process.env.CHROME_HEADLESS_SHELL
  || '/home/hj/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE_URL || 'http://localhost:5180';

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });

const checks = [];
const check = (name, condition) => checks.push({ name, ok: Boolean(condition) });

await page.waitForSelector('.issue-card');
check('汇总卡片渲染 6 张', await page.locator('.stat').count() === 6);
check('问题清单默认 2 条', await page.locator('.issue-card').count() === 2);
check('明细表 16 个片段', await page.locator('#clip-table tbody tr').count() === 16);
check('时间线 10 条事件', await page.locator('.tl-event').count() === 10);

const fpsCard = page.locator('.issue-card', { hasText: '帧率写错' });
check('帧率写错问题可见', await fpsCard.count() === 1);
await fpsCard.click();
await page.waitForSelector('#detail-overlay:not(.hidden)');
const detailText = await page.locator('#detail-body').innerText();
check('详情定位到 P003', detailText.includes('P003'));
check('详情显示帧率 25 / 期望 24', detailText.includes('25') && detailText.includes('24'));
const highlighted = await page.locator('tr.flash[data-proxy="P003"]').count();
check('对应表格行高亮定位', highlighted === 1);
await page.click('#detail-close');

const audioCard = page.locator('.issue-card', { hasText: '音频偏移' });
await audioCard.click();
const audioDetail = await page.locator('#detail-body').innerText();
check('音频问题定位到 P009', audioDetail.includes('P009') && audioDetail.includes('120'));
await page.click('#detail-close');

await page.locator('.fault-item', { hasText: '起始帧提前' }).click();
await page.waitForFunction(() => document.querySelectorAll('.issue-card').length >= 3);
check('开启提前故障后问题增加', await page.locator('.issue-card', { hasText: '提前' }).count() === 1);

await page.click('#btn-select-none');
await page.waitForFunction(() => document.querySelectorAll('.issue-card').length === 0);
check('清空故障后零问题', await page.locator('.stat.ok .num').first().textContent());

check('浏览器无 JS 报错', errors.length === 0);
if (errors.length) console.log('浏览器错误:', errors);

let failed = 0;
for (const item of checks) {
  console.log(`${item.ok ? '✔' : '✖'} ${item.name}`);
  if (!item.ok) failed += 1;
}
await browser.close();
process.exit(failed ? 1 : 0);
