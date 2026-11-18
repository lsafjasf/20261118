import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const port = Number(process.env.TEST_PORT || 8092);
const baseUrl = `http://127.0.0.1:${port}`;
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/home/hj/.cache/ms-playwright/chromium-1169/chrome-linux/chrome",
  "/home/hj/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  "/home/hj/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome",
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => existsSync(candidate));

assert(executablePath, "未找到 Chromium，请设置 CHROME_PATH");
mkdirSync("artifacts", { recursive: true });

const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/receiver.html`);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`本地服务未能启动：\n${serverOutput}`);
}

const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"],
});
const errors = [];
let receiver;
let sender;

try {
  await waitForServer();
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 } });
  receiver = await context.newPage();
  sender = await context.newPage();
  for (const page of [receiver, sender]) {
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  }

  await receiver.goto(`${baseUrl}/receiver.html`);
  await sender.goto(`${baseUrl}/sender.html`);
  await sender.click("#startBtn");
  await sender.waitForFunction(() => window.__sender?.getState().connectionState === "connected", null, {
    timeout: 15000,
  });
  await receiver.waitForFunction(() => window.__receiver?.getSnapshot().latest.video, null, {
    timeout: 15000,
  });
  await receiver.waitForFunction(
    () => window.__receiver.getSnapshot().history.video.length >= 4,
    null,
    { timeout: 10000 },
  );
  await receiver.waitForTimeout(2500);

  const normal = await receiver.evaluate(() => window.__receiver.getSnapshot());
  assert(normal.latest.video.frameWidth > 0, "视频 frameWidth 未采集");
  assert(normal.latest.video.frameHeight > 0, "视频 frameHeight 未采集");
  assert.equal(normal.latest.video.frameWidth, 640, "视频采集宽度不是 640");
  assert.equal(normal.latest.video.frameHeight, 360, "视频采集高度不是 360");
  assert(normal.latest.video.fps > 15, `正常视频帧率过低：${normal.latest.video.fps}`);
  assert(normal.latest.audio.packetsReceived > 0, "音频包未接收");
  assert(
    normal.health.video.phase !== "alert",
    `正常带宽下不应出现视频告警：${JSON.stringify({
      latest: normal.latest.video,
      health: normal.health.video,
    })}`,
  );
  assert(
    normal.health.audio.phase !== "alert",
    `正常带宽下不应出现音频告警：${JSON.stringify(normal.health.audio)}`,
  );
  await sender.screenshot({ path: "artifacts/verified-sender.png", fullPage: true });
  await receiver.screenshot({ path: "artifacts/verified-normal.png", fullPage: true });

  const alertStart = Date.now();
  await sender.click("#capBtn");
  await receiver.waitForFunction(
    () => window.__receiver.getSnapshot().health.video.phase === "alert",
    null,
    { timeout: 25000 },
  );
  await receiver.waitForTimeout(1500);
  const alert = await receiver.evaluate(() => window.__receiver.getSnapshot());
  const alertElapsed = Date.now() - alertStart;
  assert(alert.latest.video.frameIntervalMs > 90, "限速后未观察到帧到达间隔异常");
  assert(alert.health.video.incident?.startedAt, "视频首次异常时间未记录");
  assert(alert.health.audio.phase !== "alert", "视频限速不应误判音频告警");
  assert.equal(await receiver.locator("#videoQuality").getAttribute("class"), "quality-card is-alert");
  const firstAnomaly = await receiver.locator("#videoFirstAnomaly").textContent();
  assert(firstAnomaly && firstAnomaly !== "—", "界面未展示首次异常时间");
  await receiver.screenshot({ path: "artifacts/verified-alert.png", fullPage: true });

  const senderTelemetry = await sender.evaluate(() => ({
    bitrate: document.querySelector("#sendBitrate").textContent,
    fps: document.querySelector("#sendFps").textContent,
    limitation: document.querySelector("#qualityReason").textContent,
    profile: window.__sender.getState().profileKbps,
  }));
  assert.equal(senderTelemetry.profile, 32, "发送端限速配置未生效");

  await sender.click("#restoreBtn");
  await receiver.waitForFunction(
    () => window.__receiver.getSnapshot().health.video.phase === "recovered",
    null,
    { timeout: 25000 },
  );
  await receiver.waitForTimeout(1500);
  const recovered = await receiver.evaluate(() => window.__receiver.getSnapshot());
  assert(recovered.latest.video.fps > 15, `恢复后视频帧率未回升：${recovered.latest.video.fps}`);
  assert(
    recovered.latest.video.frameIntervalMs < 90,
    `恢复后帧到达间隔仍异常：${recovered.latest.video.frameIntervalMs}`,
  );
  assert.equal(recovered.health.video.phase, "recovered", "视频告警未解除");
  assert.equal(await receiver.locator("#videoQuality").getAttribute("class"), "quality-card is-recovered");
  assert.equal(await receiver.locator("#videoFirstAnomaly").textContent(), firstAnomaly);
  assert.equal(recovered.health.audio.phase, "healthy", "音频状态不应被视频限速影响");
  await receiver.screenshot({ path: "artifacts/verified-recovered.png", fullPage: true });

  assert.deepEqual(errors, [], `浏览器运行错误：\n${errors.join("\n")}`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        alertElapsedMs: alertElapsed,
        normal: {
          fps: Number(normal.latest.video.fps.toFixed(1)),
          frameIntervalMs: Number(normal.latest.video.frameIntervalMs.toFixed(1)),
          resolution: `${normal.latest.video.frameWidth}x${normal.latest.video.frameHeight}`,
        },
        alert: {
          fps: Number(alert.latest.video.fps.toFixed(1)),
          frameIntervalMs: Number(alert.latest.video.frameIntervalMs.toFixed(1)),
          firstAnomaly,
          audioPhase: alert.health.audio.phase,
          senderTelemetry,
        },
        recovered: {
          fps: Number(recovered.latest.video.fps.toFixed(1)),
          frameIntervalMs: Number(recovered.latest.video.frameIntervalMs.toFixed(1)),
          state: recovered.health.video.phase,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  server.kill("SIGTERM");
}
