// 用浏览器原生 <video> 播放主清单，并把播放器时长与校验器解析结果对比。
// 用法: node playback_test.js [validator.json]
const http = require("http");
const fs = require("fs");
const path = require("path");
const BROWSER = process.env.BROWSER || "chromium";
const { chromium, webkit } = require("playwright");

const ROOT = __dirname;
const JSON_PATH = process.argv[2] || "/tmp/hls_ok.json";

const MIME = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".m4s": "video/iso.segment",
  ".mp4": "video/mp4",
  ".html": "text/html",
};

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel === "/player.html") {
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><video id="v" src="/demo/master.m3u8"
                 controls muted style="width:640px"></video>`);
        return;
      }
      const file = path.join(ROOT, rel);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

(async () => {
  const expected = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
  const srv = await serve();
  const PORT = srv.address().port;
  const launcher = BROWSER === "webkit" ? webkit : chromium;
  const browser = BROWSER === "webkit"
    ? await launcher.launch()
    : await launcher.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("console", (m) => console.log("[browser]", m.text()));

  await page.goto(`http://127.0.0.1:${PORT}/player.html`);
  const support = await page.evaluate(() => {
    const v = document.getElementById("v");
    return { canPlayHls: v.canPlayType("application/vnd.apple.mpegurl") };
  });
  console.log("canPlayType(application/vnd.apple.mpegurl) =",
              JSON.stringify(support.canPlayHls));

  const meta = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById("v");
    const timer = setTimeout(() => resolve({ timeout: true, error: v.error && v.error.message }),
                             20000);
    if (v.readyState >= 1) {
      clearTimeout(timer);
      resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      return;
    }
    v.addEventListener("loadedmetadata", () => {
      clearTimeout(timer);
      resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    });
    v.addEventListener("error", () => {
      clearTimeout(timer);
      resolve({ error: v.error ? `${v.error.code}: ${v.error.message}` : "unknown" });
    });
  }));

  if (meta.error || meta.timeout) {
    console.log("播放失败:", meta.error || "loadedmetadata 超时");
    await browser.close();
    srv.close();
    process.exit(1);
  }
  console.log(`loadedmetadata: duration=${meta.duration.toFixed(3)}s, ` +
              `resolution=${meta.width}x${meta.height}`);

  // 实际播放 3 秒，确认进度推进
  const played = await page.evaluate(() => new Promise((resolve) => {
    const v = document.getElementById("v");
    v.play();
    setTimeout(() => resolve({ currentTime: v.currentTime, paused: v.paused }), 3000);
  }));
  console.log(`播放 3s 后: currentTime=${played.currentTime.toFixed(3)}s, paused=${played.paused}`);

  await browser.close();
  srv.close();

  console.log("\n== 时长对比 ==");
  let ok = played.currentTime > 0.5 && !played.paused;
  for (const variant of expected.variants) {
    const diff = Math.abs(meta.duration - variant.total_duration);
    const match = diff <= 0.5;
    ok = ok && match;
    console.log(`变体 ${variant.variant}: 解析总时长 ${variant.total_duration.toFixed(3)}s, ` +
                `播放器时长 ${meta.duration.toFixed(3)}s, 偏差 ${diff.toFixed(3)}s ` +
                `=> ${match ? "MATCH" : "MISMATCH"}`);
  }
  console.log(ok ? "\n播放测试 PASS" : "\n播放测试 FAIL");
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
