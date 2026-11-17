// Drives the capture page in headless Chrome to regenerate media/store.json.
// Usage: node tools/capture.js  (server must already be running)
import { launchBrowser, waitForFlag } from './browser.js';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const browser = await launchBrowser();

try {
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('[page]', msg.text()));
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  await page.goto(`${base}/capture.html`);
  const ok = await waitForFlag(page, '__done', 180000);
  console.log(ok ? 'capture OK' : 'capture FAILED');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
