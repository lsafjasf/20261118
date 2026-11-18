import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(process.cwd());
const artifacts = join(root, "artifacts");
const port = Number(process.env.PORT || 4187);
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotTime = 18.959;

const executableCandidates = [
  process.env.CHROME_PATH,
  chromium.executablePath(),
  "/home/hj/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome",
  "/home/hj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  "/home/hj/.cache/puppeteer/chrome/linux-157.0.8103.50/chrome-linux64/chrome",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome"
].filter(Boolean);

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

async function serverIsUp() {
  try {
    const response = await fetch(`${baseUrl}/index.html`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  if (await serverIsUp()) return null;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await serverIsUp()) return child;
    if (child.exitCode != null) throw new Error(`Server exited: ${output}`);
    await delay(100);
  }
  child.kill();
  throw new Error(`Server startup timed out: ${output}`);
}

async function seekMarker(page, segmentIndex) {
  await page.evaluate(index => window.__cueDesk.seekSegment(index), segmentIndex);
  await page.waitForFunction(
    index => window.__cueDesk.snapshot().segmentIndex === index,
    segmentIndex,
    { timeout: 8000 }
  );
  await delay(180);
}

await mkdir(artifacts, { recursive: true });
const server = await startServer();
const executablePath = executableCandidates.find(path => existsSync(path));
if (!executablePath) throw new Error("No Chromium executable found. Set CHROME_PATH.");

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
    "--mute-audio"
  ]
});
const page = await browser.newPage({
  viewport: { width: 1500, height: 1100 },
  deviceScaleFactor: 1
});
const pageErrors = [];
page.on("pageerror", error => pageErrors.push(error.message));
page.on("console", message => {
  if (message.type() === "error") pageErrors.push(message.text());
});

try {
  await page.goto(`${baseUrl}/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__cueDesk), null, { timeout: 15000 });
  await page.waitForFunction(() => window.__cueDesk.player.ready, null, { timeout: 15000 });

  await seekMarker(page, 0);
  await seekMarker(page, 5);
  await seekMarker(page, 6);
  await page.evaluate(() => window.__cueDesk.player.play());
  await page.waitForFunction(
    time => window.__cueDesk.snapshot().currentTime >= time,
    screenshotTime - 0.12,
    { timeout: 12000 }
  );
  await page.evaluate(() => window.__cueDesk.player.pause());
  await page.evaluate(time => window.__cueDesk.seek(time), screenshotTime);
  await delay(350);
  await page.waitForFunction(
    () => window.__cueDesk.snapshot().phase === "ad",
    null,
    { timeout: 6000 }
  );

  const report = await page.evaluate(() => ({
    state: window.__cueDesk.snapshot(),
    json: window.__cueDesk.exports.json(),
    csv: window.__cueDesk.exports.csv(),
    markdown: window.__cueDesk.exports.markdown()
  }));

  await writeFile(
    join(artifacts, "cue-events.json"),
    `${JSON.stringify(report.json, null, 2)}\n`
  );
  await writeFile(join(artifacts, "cue-events.csv"), `${report.csv}\n`);
  await writeFile(join(artifacts, "cue-events.md"), `${report.markdown}\n`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, "screenshot.png"), fullPage: true });
  await page.locator("#timelinePanel").screenshot({ path: join(artifacts, "timeline.png") });
  await page.locator("#eventTablePanel").screenshot({ path: join(artifacts, "event-table.png") });

  const metadata = {
    playerMode: report.state.ready ? "ready" : "loading",
    phase: report.state.phase,
    playerState: {
      phase: report.state.phase,
      time: report.state.currentTime,
      fragment: report.state.segmentIndex,
      log: report.state.logs
    },
    summary: report.json.summary,
    diagnostics: report.json.diagnostics,
    pageErrors,
    screenshots: ["screenshot.png", "timeline.png", "event-table.png"]
  };
  await writeFile(
    join(artifacts, "screenshot-meta.json"),
    `${JSON.stringify(metadata, null, 2)}\n`
  );

  console.log(
    `Captured ${report.state.phase.toUpperCase()} at ${report.state.currentTime.toFixed(3)}s ` +
      `(fragment #${String(report.state.segmentIndex).padStart(2, "0")})`
  );
  console.log(`Artifacts written to ${artifacts}`);
  if (pageErrors.length) console.warn("Page errors:", pageErrors);
} finally {
  await browser.close();
  if (server) server.kill();
}
