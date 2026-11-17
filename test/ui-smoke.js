// UI smoke test: serve the repo, drive the page with headless Chromium,
// verify top-3 rendering and correct verdicts for every query variant.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

const server = createServer(async (req, res) => {
  try {
    const path = join(ROOT, req.url === "/" ? "web/index.html" : req.url);
    const data = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
await page.goto(`http://127.0.0.1:${port}/web/index.html`);

await page.click("#btn-index");
await page.waitForFunction(
  () => document.getElementById("status").textContent.includes("可以查询"),
  null,
  { timeout: 120000 }
);
console.log("index built:", await page.textContent("#log"));

const cases = ["clean", "noisy", "fast", "pitch", "unrelated"];
let failures = 0;
for (const name of cases) {
  await page.click(`button[data-case="${name}"]`);
  await page.waitForFunction(
    () => document.querySelectorAll("#results-body tr").length > 0,
    null,
    { timeout: 120000 }
  );
  const rows = await page.$$eval("#results-body tr", (trs) =>
    trs.map((tr) => ({
      song: tr.cells[1].textContent.trim(),
      offset: tr.cells[2].textContent.trim(),
      matches: tr.cells[3].textContent.trim(),
      verdict: tr.cells[5].textContent.trim(),
    }))
  );
  console.log(`\ncase ${name}: ${rows.length} candidates`);
  rows.forEach((r, i) => console.log(`  #${i + 1}`, r.song, "|", r.offset, "|", r.matches, "|", r.verdict));
  if (rows.length === 0) { console.log("  FAIL: no candidates"); failures++; continue; }
  if (name === "unrelated") {
    if (rows[0].verdict !== "低于阈值") { console.log("  FAIL: unrelated should be below threshold"); failures++; }
  } else if (rows[0].song !== "歌曲 1" || rows[0].verdict !== "命中") {
    console.log("  FAIL: expected 歌曲 1 命中 at rank 1");
    failures++;
  }
}

await browser.close();
server.close();
console.log(failures === 0 ? "\nUI SMOKE TEST PASSED" : `\n${failures} UI CASE(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
