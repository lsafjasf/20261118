import puppeteer from 'puppeteer';

export async function launchBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-precise-memory-info',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--enable-unsafe-webgpu',
      '--mute-audio',
    ],
  });
}

export async function waitForFlag(page, name, timeoutMs = 120000) {
  await page.waitForFunction(`window.${name} !== undefined`, { timeout: timeoutMs });
  return page.evaluate(`window.${name}`);
}
