import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { launchTestPage, stopBrowser, PROJECT_ROOT } from './lib/browser.js';

const FIXTURE = join(PROJECT_ROOT, 'tests', 'fixtures', 'chapters-20.webm');
const EXPECTED = join(PROJECT_ROOT, 'tests', 'fixtures', 'chapters-20.expected.json');

let handle;
let page;
let videoBuffer;
let expected;

before(async () => {
  handle = await launchTestPage();
  page = handle.page;
  const [webm, json] = await Promise.all([readFile(FIXTURE), readFile(EXPECTED, 'utf8')]);
  videoBuffer = webm.toString('base64');
  expected = JSON.parse(json);
});

after(async () => {
  if (handle) await stopBrowser(handle);
});

async function runInBrowser(fn, payload) {
  return page.evaluate(
    async ({ fnSource, payload }) => {
      const fn = new Function(`return (${fnSource})`)();
      if (payload?.bufferBase64) {
        const binary = atob(payload.bufferBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        payload.buffer = bytes.buffer;
        delete payload.bufferBase64;
      }
      return fn(window.__harness, payload);
    },
    { fnSource: fn.toString(), payload }
  );
}

test('WebCodecs APIs are available in the headless browser', async () => {
  const capabilities = await page.evaluate(() => ({
    VideoDecoder: typeof VideoDecoder,
    VideoFrame: typeof VideoFrame,
    EncodedVideoChunk: typeof EncodedVideoChunk,
    OffscreenCanvas: typeof OffscreenCanvas,
    createImageBitmap: typeof createImageBitmap
  }));
  assert.deepEqual(capabilities, {
    VideoDecoder: 'function',
    VideoFrame: 'function',
    EncodedVideoChunk: 'function',
    OffscreenCanvas: 'function',
    createImageBitmap: 'function'
  });
});

test('produces 60 thumbnails (20 chapters x 3) with correct count and ordering', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const wall = await h.generateThumbnailWall(payload.buffer, {
        concurrency: 3,
        thumbnailWidth: 160
      });
      return {
        chapterCount: wall.chapters.length,
        slotsPerChapter: wall.chapters.map((chapter) => chapter.thumbnails.length),
        slotNames: wall.chapters.map((chapter) =>
          chapter.thumbnails.map((thumbnail) => thumbnail.slot)
        ),
        ptsMatrix: wall.chapters.map((chapter) =>
          chapter.thumbnails.map((thumbnail) => thumbnail.ptsMs)
        ),
        stats: wall.stats
      };
    },
    { bufferBase64: videoBuffer }
  );

  assert.equal(result.chapterCount, 20);
  assert.ok(result.slotsPerChapter.every((count) => count === 3));
  assert.ok(
    result.slotNames.every((names) =>
      ['start', 'middle', 'end'].every((name, index) => names[index] === name)
    )
  );
  for (const pts of result.ptsMatrix) {
    assert.ok(pts[0] < pts[1] && pts[1] < pts[2], 'slots must be PTS ordered');
  }
  const total = result.slotsPerChapter.reduce((sum, count) => sum + count, 0);
  assert.equal(total, 60);
});

test('every thumbnail PTS maps to a real frame inside its chapter boundaries', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const wall = await h.generateThumbnailWall(payload.buffer, { concurrency: 2 });
      const parsed = h.parseWebm(payload.buffer);
      return {
        wall: wall.chapters.map((chapter) => ({
          chapterIndex: chapter.chapterIndex,
          startMs: chapter.startMs,
          endMs: chapter.endMs,
          title: chapter.title,
          thumbnails: chapter.thumbnails.map((thumbnail) => ({
            slot: thumbnail.slot,
            ptsMs: thumbnail.ptsMs,
            targetPtsMs: thumbnail.targetPtsMs
          }))
        })),
        framePts: parsed.frames.map((frame) => frame.ptsMs)
      };
    },
    { bufferBase64: videoBuffer }
  );

  result.wall.forEach((chapter, index) => {
    const want = expected.chapters[index];
    assert.equal(chapter.startMs, want.startMs);
    assert.equal(chapter.endMs, want.endMs);
    assert.equal(chapter.title, want.title);
    for (const thumbnail of chapter.thumbnails) {
      assert.ok(
        result.framePts.includes(thumbnail.ptsMs),
        'PTS must exist in source frames'
      );
      assert.ok(
        thumbnail.ptsMs >= chapter.startMs && thumbnail.ptsMs < chapter.endMs,
        `thumbnail ${thumbnail.slot} outside chapter ${index}`
      );
    }
  });
});

test('chapter timing matches the fixture expectations exactly', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const parsed = h.parseWebm(payload.buffer);
      return parsed.chapters;
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.length, expected.chapterCount);
  result.forEach((chapter, index) => {
    assert.equal(chapter.startMs, expected.chapters[index].startMs);
    assert.equal(chapter.endMs, expected.chapters[index].endMs);
    assert.equal(chapter.title, expected.chapters[index].title);
  });
});

test('decode concurrency stays at or below the configured limit', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const statsSink = { maxInFlight: 0 };
      const wall = await h.generateThumbnailWall(payload.buffer, {
        concurrency: 2,
        statsSink
      });
      return { maxInFlight: statsSink.maxInFlight, wallMax: wall.stats.maxInFlight };
    },
    { bufferBase64: videoBuffer }
  );
  assert.ok(result.maxInFlight <= 2, `observed ${result.maxInFlight} > limit 2`);
  assert.equal(result.maxInFlight, 2);
  assert.equal(result.wallMax, 2);
});

test('no VideoFrame remains live after a successful run', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const registry = new h.FrameRegistry();
      const wall = await h.generateThumbnailWall(payload.buffer, {
        concurrency: 3,
        frameRegistry: registry
      });
      return { snapshot: registry.snapshot(), thumbnails: wall.chapters.length * 3 };
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.snapshot.live, 0);
  assert.equal(result.snapshot.created, 60);
  assert.equal(result.snapshot.released, 60);
  assert.equal(result.snapshot.doubleReleases, 0);
});

test('cancellation releases every temporary VideoFrame and aborts the task', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const registry = new h.FrameRegistry();
      const controller = new AbortController();
      let errorName = null;
      const promise = h.generateThumbnailWall(payload.buffer, {
        concurrency: 2,
        signal: controller.signal,
        frameRegistry: registry
      });
      controller.abort();
      try {
        await promise;
      } catch (error) {
        errorName = error.name;
      }
      // Give microtasks queued by decoder.reset() a chance to settle.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { errorName, snapshot: registry.snapshot() };
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.errorName, 'AbortError');
  assert.equal(result.snapshot.live, 0, 'all temporary frames must be released after abort');
  assert.equal(result.snapshot.leaked ?? result.snapshot.live, 0);
  assert.equal(result.snapshot.created, result.snapshot.released);
});

test('abort before start rejects without decoding or leaking', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const registry = new h.FrameRegistry();
      const controller = new AbortController();
      controller.abort();
      let errorName = null;
      try {
        await h.generateThumbnailWall(payload.buffer, {
          signal: controller.signal,
          frameRegistry: registry
        });
      } catch (error) {
        errorName = error.name;
      }
      return { errorName, snapshot: registry.snapshot() };
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.errorName, 'AbortError');
  assert.equal(result.snapshot.created, 0);
  assert.equal(result.snapshot.live, 0);
});

test('export manifest records source frame PTS for every thumbnail', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const wall = await h.generateThumbnailWall(payload.buffer, { concurrency: 3 });
      const selections = new Map();
      selections.set(0, { slot: 'start', ptsMs: wall.chapters[0].thumbnails[0].ptsMs });
      selections.set(7, { slot: 'end', ptsMs: wall.chapters[7].thumbnails[2].ptsMs });
      const manifest = h.buildManifest(wall, selections);
      const bundle = await h.buildExportBundle(wall, selections);
      const ptsProbe = manifest.chapters.flatMap((chapter) =>
        chapter.thumbnails.map((thumbnail) => thumbnail.sourcePtsMs)
      );
      return {
        manifest,
        fileCount: bundle.files.length,
        allPtsNumbers: ptsProbe.every((value) => Number.isFinite(value)),
        selectedChapter0: manifest.chapters[0].selected,
        selectedChapter7: manifest.chapters[7].selected,
        defaultMiddle: manifest.chapters[1].selected
      };
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.manifest.chapters.length, 20);
  assert.equal(result.allPtsNumbers, true);
  assert.equal(result.manifest.chapters[0].thumbnails.length, 3);
  assert.equal(result.selectedChapter0.slot, 'start');
  assert.equal(result.selectedChapter7.slot, 'end');
  assert.equal(result.defaultMiddle.slot, 'middle');
  for (const chapter of result.manifest.chapters) {
    for (const thumbnail of chapter.thumbnails) {
      assert.ok('sourcePtsMs' in thumbnail);
      assert.ok(
        expected.chapters[chapter.chapterIndex].framePtsMs.includes(
          thumbnail.sourcePtsMs
        ),
        `manifest PTS ${thumbnail.sourcePtsMs} not found in fixture frame list`
      );
      assert.ok(
        thumbnail.sourcePtsMs >= chapter.startMs &&
          thumbnail.sourcePtsMs < chapter.endMs
      );
    }
  }
  // 60 PNGs + manifest.json
  assert.equal(result.fileCount, 61);
});

test('thumbnail blobs are valid PNGs with the requested raster size', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const wall = await h.generateThumbnailWall(payload.buffer, {
        concurrency: 4,
        thumbnailWidth: 120
      });
      const first = wall.chapters[0].thumbnails[0];
      const bytes = new Uint8Array(await first.blob.arrayBuffer());
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      return {
        width: first.width,
        height: first.height,
        isPng: signature.every((byte, index) => bytes[index] === byte),
        blobType: first.blob.type,
        sourceWidth: wall.source.width,
        sourceHeight: wall.source.height
      };
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.isPng, true);
  assert.equal(result.blobType, 'image/png');
  assert.equal(result.width, 120);
  const expectedHeight = Math.max(
    1,
    Math.round((result.sourceHeight * 120) / result.sourceWidth)
  );
  assert.equal(result.height, expectedHeight);
});

test('UI renders 20 chapter rows, supports frame selection and export', async () => {
  await page.goto(`${handle.urlPrefix}/tests/browser/ui-harness.html`);
  await page.waitForFunction(() => window.__uiReady === true);
  await page.evaluate(
    async (base64) => {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await window.__uiApp.load(bytes.buffer);
    },
    videoBuffer
  );

  const rowCount = await page.locator('.chapter-row').count();
  assert.equal(rowCount, 20);
  const cardCount = await page.locator('.thumbnail-card').count();
  assert.equal(cardCount, 60);

  // Default selection is the middle slot of every chapter.
  assert.equal(
    await page.locator('.chapter-row').first().locator('.thumbnail-card.selected').count(),
    1
  );
  assert.equal(
    await page
      .locator('.chapter-row')
      .first()
      .locator('.thumbnail-card.selected')
      .getAttribute('data-slot'),
    'middle'
  );

  // User picks the "end" frame in the first chapter.
  await page
    .locator('.chapter-row')
    .first()
    .locator('.thumbnail-card[data-slot="end"]')
    .click();
  const selectedPts = await page
    .locator('.chapter-row')
    .first()
    .locator('.thumbnail-card.selected')
    .getAttribute('data-pts-ms');

  const exported = await page.evaluate(async () => {
    const bundle = await window.__uiApp.exportBundle();
    return {
      fileCount: bundle.files.length,
      firstSelection: bundle.manifest.chapters[0].selected,
      secondSelection: bundle.manifest.chapters[1].selected,
      ptsRecorded: bundle.manifest.chapters[0].thumbnails.map(
        (item) => item.sourcePtsMs
      )
    };
  });
  assert.equal(exported.fileCount, 61);
  assert.equal(exported.firstSelection.slot, 'end');
  assert.equal(exported.firstSelection.sourcePtsMs, Number(selectedPts));
  assert.equal(exported.secondSelection.slot, 'middle');
  assert.equal(exported.ptsRecorded.length, 3);

  // Go back to the module harness for any later tests.
  await page.goto(`${handle.urlPrefix}/tests/browser/harness.html`);
  await page.waitForFunction(() => window.__harnessReady === true);
});

test('mid-flight cancellation during decode frees every frame', async () => {
  const result = await runInBrowser(
    async (h, payload) => {
      const registry = new h.FrameRegistry();
      const controller = new AbortController();
      let errorName = null;
      const promise = h.generateThumbnailWall(payload.buffer, {
        concurrency: 1,
        signal: controller.signal,
        frameRegistry: registry
      });
      // Let several frames decode, then abort while work remains.
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.abort();
      try {
        await promise;
      } catch (error) {
        errorName = error.name;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        errorName,
        snapshot: registry.snapshot(),
        createdSomeFrames: registry.snapshot().created > 0
      };
    },
    { bufferBase64: videoBuffer }
  );
  assert.equal(result.errorName, 'AbortError');
  assert.equal(result.createdSomeFrames, true);
  assert.equal(result.snapshot.live, 0);
  assert.equal(result.snapshot.created, result.snapshot.released);
});

test('FrameRegistry double-release is rejected and leak count stays accurate', async () => {
  const result = await runInBrowser(async (h) => {
    const registry = new h.FrameRegistry();
    const fakeFrame = { closed: false, close() { this.closed = true; } };
    registry.register(fakeFrame);
    let threw = false;
    try {
      registry.release(fakeFrame);
      registry.release(fakeFrame);
    } catch {
      threw = true;
    }
    return { threw, snapshot: registry.snapshot(), frameClosed: fakeFrame.closed };
  }, {});
  assert.equal(result.threw, true);
  assert.equal(result.frameClosed, true);
  assert.equal(result.snapshot.doubleReleases, 1);
  assert.equal(result.snapshot.live, 0);
});
