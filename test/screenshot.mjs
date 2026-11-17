import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: '/home/hj/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto('http://localhost:5180', { waitUntil: 'networkidle' });
await page.waitForSelector('.issue-card');
await page.locator('.issue-card', { hasText: '帧率写错' }).click();
await page.waitForSelector('#detail-overlay:not(.hidden)');
await page.screenshot({ path: 'reports/ui-screenshot.png', fullPage: false });
await browser.close();
console.log('截图已保存: reports/ui-screenshot.png');
