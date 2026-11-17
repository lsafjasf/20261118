// Drives a real <video> element (Chrome + hls.js) through the rebuilt
// playlist and asserts playback reaches the `ended` event.
//
// Usage:
//   CHROME=/path/to/chrome node browser_verify.mjs [playlist-url-path]
// Defaults: CHROME from $CHROME or common local paths,
//           playlist demo/rebuilt/index.m3u8 served over a temp HTTP server.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || "rebuilt/index.m3u8";

const chromeCandidates = [
  process.env.CHROME,
  "/tmp/chrome/chrome-linux64/chrome",
].filter(Boolean);
const executablePath = chromeCandidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error("no Chrome executable found; set CHROME=/path/to/chrome");
  process.exit(2);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
};
const server = createServer(async (req, res) => {
  try {
    const file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page]", m.text());
  });
  await page.goto(
    `http://127.0.0.1:${port}/demo/player.html?src=${encodeURIComponent(src)}`,
  );
  await page.waitForFunction(
    () => window.__result && (window.__result.ended ||
                              window.__result.errors.length > 0),
    null,
    { timeout: 120000 },
  );
  const result = await page.evaluate(() => window.__result);
  const reachedEnd =
    result.ended &&
    Math.abs(result.currentTime - result.duration) < 1.0 &&
    result.errors.length === 0;
  console.log(JSON.stringify({ plays_to_end: reachedEnd, ...result }, null, 2));
  process.exitCode = reachedEnd ? 0 : 1;
} finally {
  await browser.close();
  server.close();
}
