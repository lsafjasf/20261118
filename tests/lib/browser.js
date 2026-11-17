// Playwright launcher for the in-browser WebCodecs test suite.
// Headless Chromium is installed through playwright-core; system Chrome is
// never assumed.
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createServer } from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(HERE, '..', '..');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.css': 'text/css'
};

// file:// pages cannot import ES modules in Chromium (origin "null" CORS),
// so the harness is served over a loopback HTTP server for the test run.
function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (request, response) => {
      const pathname = decodeURIComponent(
        new URL(request.url, 'http://127.0.0.1').pathname
      );
      const filePath = join(
        PROJECT_ROOT,
        pathname === '/' ? 'tests/browser/harness.html' : pathname
      );
      if (!filePath.startsWith(PROJECT_ROOT)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      try {
        const data = await readFile(filePath);
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
        });
        response.end(data);
      } catch {
        response.writeHead(404);
        response.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function browserExecutables() {
  const cacheRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? join(homedir(), '.cache', 'ms-playwright');
  const candidates = [];
  for (const entry of existsSync(cacheRoot) ? readdirSync(cacheRoot) : []) {
    if (entry.startsWith('chromium_headless_shell-')) {
      candidates.push(
        join(cacheRoot, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        join(cacheRoot, entry, 'chrome-linux', 'headless_shell')
      );
    }
    if (entry.startsWith('chromium-')) {
      candidates.push(
        join(cacheRoot, entry, 'chrome-linux64', 'chrome'),
        join(cacheRoot, entry, 'chrome-linux', 'chrome')
      );
    }
  }
  return candidates.filter((path) => existsSync(path));
}

export async function launchTestPage() {
  const executablePath = browserExecutables()[0];
  if (!executablePath) {
    throw new Error('Chromium not found; run "npx playwright-core install chromium"');
  }
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader']
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (!text.includes('Failed to load resource')) {
        console.error(`[browser] ${text}`);
      }
    }
  });
  page.on('pageerror', (error) => console.error(`[pageerror] ${error.stack}`));
  const server = await startStaticServer();
  const port = server.address().port;
  await page.goto(`http://127.0.0.1:${port}/tests/browser/harness.html`);
  await page.waitForFunction(() => window.__harnessReady === true);
  const urlPrefix = `http://127.0.0.1:${port}`;
  return { browser, context, page, server, port, urlPrefix };
}

export async function stopBrowser(handle) {
  await handle.context.close();
  await handle.browser.close();
  await new Promise((resolve) => handle.server.close(resolve));
}
