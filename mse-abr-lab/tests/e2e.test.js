const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const puppeteer = require('puppeteer');

const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;

function startServer() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
}

async function launch() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
}

async function newPage(browser, profile = null) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const url = profile ? `${BASE}/?profile=${profile}` : `${BASE}/`;
  await page.goto(url, { waitUntil: 'networkidle0' });
  return { page, errors };
}

async function waitForSegments(page, count, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => window.__lab.player.getStats().nextSegment);
    if (done >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${count} segments`);
}

test('slow network produces explicit up/down switch records at segment boundaries', async () => {
  const server = startServer();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const browser = await launch();
  try {
    const { page, errors } = await newPage(browser, 'slow');
    await waitForSegments(page, 30);

    const result = await page.evaluate(() => {
      const { abr, player, eventLog } = window.__lab;
      const stats = player.getStats();
      const decisions = abr.getState().history;
      const appended = stats.appended;
      const boundariesOk = appended.every((item, index) => item.segmentIndex === index);
      const uniqueReasons = [...new Set(decisions.map((item) => item.reason))];
      const renditions = [...new Set(decisions.map((item) => item.rendition))];
      return {
        stallCount: stats.stallCount,
        appendedCount: appended.length,
        boundariesOk,
        uniqueReasons,
        renditions,
        decisions: decisions.map((item) => ({
          segmentIndex: item.segmentIndex,
          rendition: item.rendition,
          reason: item.reason,
          bufferSeconds: item.bufferSeconds,
        })),
      };
    });

    assert.equal(result.appendedCount, 30);
    assert.equal(result.boundariesOk, true);
    assert.ok(result.renditions.length >= 2, `expected ABR movement, got ${result.renditions}`);
    assert.ok(result.uniqueReasons.some((reason) => reason.startsWith('throughput-')));
    assert.ok(!result.uniqueReasons.includes(undefined));
    assert.ok(errors.length === 0, `page errors: ${errors.join('; ')}`);
    console.log('slow-network reasons:', result.uniqueReasons.join(', '));
    console.log('slow-network rendition path:',
      result.decisions.map((item) => `${item.segmentIndex}:${item.rendition}`).join(' '));
  } finally {
    await browser.close();
    server.kill();
  }
});

test('jitter bursts cause buffer-emergency downshifts and recovery', async () => {
  const server = startServer();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const browser = await launch();
  try {
    const { page, errors } = await newPage(browser, 'jitter');
    await page.evaluate(() => {
      const lab = window.__lab;
      lab.network.injectBurst(150_000, 8_000, 0.1);
      setTimeout(() => lab.network.injectBurst(120_000, 8_000, 0.1), 12_000);
    });
    await waitForSegments(page, 30);

    const result = await page.evaluate(() => {
      const decisions = window.__lab.abr.getState().history;
      return {
        reasons: [...new Set(decisions.map((item) => item.reason))],
        emergencies: decisions.filter((item) => item.reason === 'buffer-emergency'),
        upshifts: decisions.filter((item) => item.reason === 'throughput-upshift'),
        stalls: window.__lab.player.getStats().stallCount,
      };
    });

    assert.ok(result.upshifts.length >= 1, 'should reach a higher tier on fast baseline');
    assert.ok(result.emergencies.length >= 1, 'burst should trigger buffer-emergency');
    console.log('jitter reasons:', result.reasons.join(', '));
    console.log('emergency events:',
      result.emergencies.map((item) => `seg#${item.segmentIndex}@${item.bufferSeconds}s`).join(', '));
    assert.ok(errors.length === 0, `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
    server.kill();
  }
});

test('manual lock pauses ABR without interrupting playback', async () => {
  const server = startServer();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const browser = await launch();
  try {
    const { page, errors } = await newPage(browser);
    await waitForSegments(page, 4);
    const before = await page.evaluate(() => ({
      time: window.__lab.video.currentTime,
      segment: window.__lab.player.getStats().nextSegment,
    }));

    await page.evaluate(() => window.__lab.abr.lock(2));
    const lockDeadline = Date.now() + 15_000;
    while (Date.now() < lockDeadline) {
      const current = await page.evaluate(() => window.__lab.abr.getState().currentIndex);
      if (current === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const after = await page.evaluate(() => {
      const state = window.__lab.abr.getState();
      return {
        time: window.__lab.video.currentTime,
        segment: window.__lab.player.getStats().nextSegment,
        locked: state.lockedIndex,
        reasons: state.history
          .filter((item) => item.reason === 'manual-lock' || item.reason === 'hold-manual-lock')
          .map((item) => item.reason),
        current: state.currentIndex,
      };
    });

    assert.equal(after.locked, 2);
    assert.equal(after.current, 2);
    assert.ok(after.reasons.includes('manual-lock'));
    assert.ok(after.reasons.length >= 2);
    assert.ok(after.reasons.every((reason) => reason === 'manual-lock' || reason === 'hold-manual-lock'));
    assert.ok(after.time > before.time, 'playback must keep advancing after lock');
    assert.ok(after.segment > before.segment);

    await page.evaluate(() => window.__lab.abr.unlock());
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const resumed = await page.evaluate(() => {
      const latest = window.__lab.abr.getState().history.at(-1);
      return { reason: latest.reason, locked: window.__lab.abr.getState().lockedIndex };
    });
    assert.equal(resumed.locked, null);
    assert.notEqual(resumed.reason, 'hold-manual-lock');
    assert.ok(errors.length === 0, `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
    server.kill();
  }
});

test('audio timeline stays continuous across multiple rendition switches', async () => {
  const server = startServer();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const browser = await launch();
  try {
    const { page, errors } = await newPage(browser, 'slow');
    await waitForSegments(page, 24);
    const result = await page.evaluate(() => new Promise((resolve) => {
      const video = window.__lab.video;
      const collected = [];
      const timer = setInterval(() => {
        collected.push({
          t: video.currentTime,
          audioBytes: video.webkitAudioDecodedByteCount,
          videoBytes: video.webkitVideoDecodedByteCount,
        });
      }, 200);
      setTimeout(() => {
        clearInterval(timer);
        const switches = window.__lab.player.getStats().appended
          .filter((item, index, array) => index > 0 && item.rendition !== array[index - 1].rendition);
        const times = collected.map((item) => item.t);
        const monotonic = times.every((value, index) => index === 0 || value >= times[index - 1] - 0.001);
        const gaps = times.slice(1).map((value, index) => value - times[index]);
        const audioBytes = collected.map((item) => item.audioBytes);
        const audioGrowing = audioBytes.slice(1).every((value, index) => value >= audioBytes[index]);
        const audioStalls = audioBytes.slice(1)
          .filter((value, index) => value === audioBytes[index] && times[index + 1] - times[index] > 0.3).length;
        resolve({
          switchCount: switches.length,
          switchPoints: switches.map((item) => `seg#${item.segmentIndex}->${item.rendition}`),
          monotonic,
          maxGap: Math.max(...gaps),
          audioGrowing,
          audioStalls,
          finalAudioBytes: audioBytes.at(-1),
          initialAudioBytes: audioBytes[0],
        });
      }, 20_000);
    }));

    assert.ok(result.switchCount >= 3, `expected multiple switches, got ${result.switchCount}`);
    assert.equal(result.monotonic, true);
    assert.ok(result.maxGap < 0.5, `time jumped by ${result.maxGap}s`);
    assert.equal(result.audioGrowing, true, 'audio decode must not restart or freeze');
    assert.equal(result.audioStalls, 0, `audio decode stalled ${result.audioStalls} times`);
    assert.ok(result.finalAudioBytes > result.initialAudioBytes + 10_000, 'audio data kept decoding');
    console.log('audio switches:', result.switchPoints.join(' '));
    console.log(`audio continuity: maxGap=${result.maxGap.toFixed(3)}s, decodedBytes=${result.initialAudioBytes}->${result.finalAudioBytes}, stalls=${result.audioStalls}`);
    assert.ok(errors.length === 0, `page errors: ${errors.join('; ')}`);
  } finally {
    await browser.close();
    server.kill();
  }
});
