"use strict";

/* 端到端：无头 Chrome 中生成测试片 -> 载入 -> 分析 -> 真值评估 ->
   人工确认 -> 改阈值重算 -> 验证标注不被覆盖。 */
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const CHROME = "/home/hj/.cache/ms-playwright/chromium_headless_shell-1255/" +
  "chrome-headless-shell-linux64/chrome-headless-shell";
const ROOT = path.join(__dirname, "..", "..");

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--allow-file-access-from-files",
      "--autoplay-policy=no-user-gesture-required"]
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("file://" + path.join(ROOT, "index.html"));

  /* 1. 生成测试片（拦截下载）。 */
  const downloads = [];
  page.on("download", async d => {
    const dest = path.join(__dirname, d.suggestedFilename());
    await d.saveAs(dest);
    downloads.push(dest);
  });
  await page.click("#btn-generate");
  await page.waitForFunction(() =>
    document.getElementById("analyze-progress").textContent.includes("已下载"),
    null, { timeout: 30000 });
  await page.waitForTimeout(500);
  const clip = downloads.find(f => f.endsWith(".webm"));
  const gtFile = downloads.find(f => f.endsWith(".json"));
  console.log("测试片:", clip && fs.statSync(clip).size, "bytes;",
    "真值:", gtFile && fs.statSync(gtFile).size, "bytes");
  if (!clip || !gtFile) throw new Error("测试片或真值未生成");

  /* 2. 载入视频。 */
  await page.setInputFiles("#file-input", clip);
  await page.waitForFunction(() =>
    !document.getElementById("video-meta").textContent.includes("尚未"),
    null, { timeout: 15000 });
  const meta = await page.textContent("#video-meta");
  console.log("视频信息:", meta);

  /* 3. 分析（标准预设，0.1s 步长）。 */
  await page.click("#btn-analyze");
  await page.waitForFunction(() =>
    document.getElementById("analyze-progress").textContent.includes("完成"),
    null, { timeout: 120000 });
  const cardCount = await page.locator("#candidate-list .card").count();
  console.log("候选区间数:", cardCount);
  if (cardCount < 2) throw new Error("候选区间过少");

  /* 4. 载入真值并做阈值扫描。 */
  await page.setInputFiles("#gt-input", gtFile);
  await page.waitForTimeout(300);
  await page.click("#btn-sweep");
  await page.waitForSelector("#sweep-table table");
  const sweepRows = await page.locator("#sweep-table tbody tr").allInnerTexts();
  sweepRows.forEach(r => console.log("扫描:", r.replace(/\s+/g, " ")));

  /* 5. 人工确认第一个疑似冻结候选。 */
  const firstConfirm = page.locator('#candidate-list button[data-act="confirm"]').first();
  await firstConfirm.click();
  const confirmedText = await page.textContent("#review-list");
  if (!confirmedText.includes("人工")) throw new Error("人工确认未生效");
  console.log("人工确认已记录");

  /* 6. 切换宽松预设并重新分析，验证确认不被覆盖。 */
  await page.selectOption("#cfg-preset", "loose");
  await page.click("#btn-analyze");
  await page.waitForFunction(() =>
    document.getElementById("analyze-progress").textContent.includes("完成"),
    null, { timeout: 60000 });
  const kept = await page.locator('#candidate-list .badge.confirmed').count();
  if (kept < 1) throw new Error("阈值重算覆盖了已确认标注");
  console.log("阈值重算后保留的人工确认数:", kept);

  /* 7. 导出 JSON，校验内容。 */
  const jsonPromise = page.waitForEvent("download");
  await page.click("#btn-export-json");
  const jsonDl = await jsonPromise;
  const jsonPath = path.join(__dirname, "exported-result.json");
  await jsonDl.saveAs(jsonPath);
  const exported = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (exported.schema !== "vfa-result/v1") throw new Error("导出 schema 错误");
  const hasReview = exported.review.some(a => a.decision === "confirmed");
  if (!hasReview) throw new Error("导出结果缺少人工确认记录");
  console.log("导出 JSON 含", exported.intervals.length, "个区间,",
    exported.review.length, "条修订");

  if (errors.length) throw new Error("浏览器错误: " + errors.join(" | "));
  await browser.close();
  console.log("\nE2E 全部通过");
})().catch(err => { console.error(err); process.exit(1); });
