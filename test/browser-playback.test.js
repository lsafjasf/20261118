import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { mergeInputs, readInputs, verifyMerged } from "../src/merge.js";
import { ensureFixtures } from "../tools/fixtures.js";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function findChromium() {
  const candidates = [process.env.CHROMIUM_PATH, chromium.executablePath()].filter(Boolean);
  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    "/home/hj/.cache/ms-playwright",
  ].filter(Boolean);
  for (const root of cacheRoots) {
    try {
      const entries = await readdir(root);
      const revisions = entries
        .filter((name) => name.startsWith("chromium-"))
        .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
      for (const entry of revisions) {
        candidates.push(path.join(root, entry, "chrome-linux64", "chrome"));
        candidates.push(path.join(root, entry, "chrome-linux", "chrome"));
      }
    } catch {
      // Try the next cache location.
    }
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function startServer(routes) {
  const server = createServer(async (request, response) => {
    try {
      const route = routes.get(new URL(request.url, "http://localhost").pathname);
      if (!route) {
        response.writeHead(404).end();
        return;
      }
      const data = await readFile(route);
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : data.length - 1;
        response.writeHead(206, {
          "content-type": "video/mp4",
          "accept-ranges": "bytes",
          "access-control-allow-origin": "*",
          "content-range": `bytes ${start}-${end}/${data.length}`,
          "content-length": end - start + 1,
        });
        response.end(data.subarray(start, end + 1));
        return;
      }
      response.writeHead(200, {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*",
        "content-length": data.length,
      });
      response.end(data);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error.stack);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

async function playMergedFile(page, url) {
  await page.setContent('<video id="v" muted autoplay playsinline></video>');
  return page.evaluate(async (source) => {
    const video = document.querySelector("#v");
    video.src = source;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("metadata timeout")), 8000);
      video.addEventListener("loadedmetadata", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      video.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`media error ${video.error?.code}`));
      }, { once: true });
    });
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const earlyPlayback = video.currentTime;
    video.currentTime = 4.8;
    await new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true }));
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return {
      duration: video.duration,
      currentTime: video.currentTime,
      earlyPlayback,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      error: video.error?.code ?? null,
    };
  }, url);
}

async function playMissingGapPrefix(page, urls) {
  await page.setContent('<video id="v" muted autoplay playsinline></video>');
  return page.evaluate(async ({ init, segments, mime }) => {
    const video = document.querySelector("#v");
    const mediaSource = new MediaSource();
    video.src = URL.createObjectURL(mediaSource);
    await new Promise((resolve) =>
      mediaSource.addEventListener("sourceopen", resolve, { once: true }));
    if (!MediaSource.isTypeSupported(mime)) throw new Error(`Unsupported MIME ${mime}`);
    const sourceBuffer = mediaSource.addSourceBuffer(mime);
    const append = async (url) => {
      const data = await fetch(url).then((response) => response.arrayBuffer());
      const done = new Promise((resolve, reject) => {
        sourceBuffer.addEventListener("updateend", resolve, { once: true });
        sourceBuffer.addEventListener("error", reject, { once: true });
      });
      sourceBuffer.appendBuffer(data);
      await done;
    };
    const ranges = () => Array.from(
      { length: sourceBuffer.buffered.length },
      (_, index) => [
        sourceBuffer.buffered.start(index),
        sourceBuffer.buffered.end(index),
      ],
    );

    await append(init);
    await append(segments[0]);
    await append(segments[1]);
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    const beforeGap = {
      currentTime: video.currentTime,
      readyState: video.readyState,
      width: video.videoWidth,
      error: video.error?.code ?? null,
      ranges: ranges(),
    };

    await append(segments[3]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    return {
      beforeGap,
      afterGap: {
        currentTime: video.currentTime,
        error: video.error?.code ?? null,
        ranges: ranges(),
      },
    };
  }, urls);
}

test("merged file plays and a missing middle segment still plays before its gap", async (t) => {
  const browserPath = await findChromium();
  if (!browserPath) return t.skip("Chromium is not installed");
  const fixtures = await ensureFixtures();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "fmp4-browser-"));
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserPath,
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  let server = null;
  try {
    const inputs = await readInputs([fixtures.init, ...fixtures.segments]);
    const result = mergeInputs(inputs);
    verifyMerged(result.buffer);
    const mergedPath = path.join(tempDir, "merged.mp4");
    await writeFile(mergedPath, result.buffer);

    const page = await browser.newPage();
    page.on("requestfailed", (request) => {
      console.error(`request failed ${request.url()}: ${request.failure()?.errorText}`);
    });
    const serverRoutes = new Map([["/merged.mp4", mergedPath]]);
    const started = await startServer(serverRoutes);
    server = started.server;
    const { origin } = started;

    const playback = await playMergedFile(page, `${origin}/merged.mp4`);
    assert.equal(playback.error, null);
    assert.ok(playback.duration > 5.9);
    assert.ok(playback.earlyPlayback > 0.8);
    assert.ok(playback.currentTime > 5.0);
    assert.ok(playback.readyState >= 2);
    assert.equal(playback.width, 320);

    const lossyFiles = [fixtures.init, ...fixtures.segments]
      .filter((file) => !file.endsWith("seg-00002.m4s"));
    const lossy = await readInputs(lossyFiles);
    assert.deepEqual(lossy.missing, [2]);
    const lossyResult = mergeInputs(lossy, { allowGaps: true });
    verifyMerged(lossyResult.buffer);

    serverRoutes.set("/init.mp4", fixtures.init);
    fixtures.segments.forEach((segment, index) => {
      serverRoutes.set(`/seg-${String(index).padStart(5, "0")}.m4s`, segment);
    });
    const gap = await playMissingGapPrefix(page, {
      init: `${origin}/init.mp4`,
      segments: fixtures.segments.slice(0, 4).map((_, index) =>
        `${origin}/seg-${String(index).padStart(5, "0")}.m4s`),
      mime: 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
    });
    assert.equal(gap.beforeGap.error, null);
    assert.ok(gap.beforeGap.currentTime > 1.0);
    assert.ok(gap.beforeGap.readyState >= 2);
    assert.equal(gap.beforeGap.width, 320);
    assert.equal(gap.afterGap.error, null);

    console.log(`browser valid playback: ${JSON.stringify(playback)}`);
    console.log(`browser missing #2: ${JSON.stringify(gap)}`);
  } finally {
    await browser.close();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
