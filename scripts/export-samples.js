// Decode the fixture in headless Chromium and persist a few thumbnail PNGs
// plus the export manifest for manual inspection.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { launchTestPage, stopBrowser, PROJECT_ROOT } from '../tests/lib/browser.js';

const outputDir = join(PROJECT_ROOT, 'test-output', 'samples');
await mkdir(outputDir, { recursive: true });

const handle = await launchTestPage();
const base64 = (
  await readFile(join(PROJECT_ROOT, 'tests', 'fixtures', 'chapters-20.webm'))
).toString('base64');

const sample = await handle.page.evaluate(
  async (payloadBase64) => {
    const binary = atob(payloadBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const wall = await window.__harness.generateThumbnailWall(bytes.buffer, {
      concurrency: 2,
      thumbnailWidth: 200
    });
    const bundle = await window.__harness.buildExportBundle(wall);
    const wanted = [];
    for (const chapterIndex of [0, 7, 19]) {
      for (const thumbnail of wall.chapters[chapterIndex].thumbnails) {
        wanted.push({
          name: `ch${String(chapterIndex + 1).padStart(2, '0')}-${thumbnail.slot}.png`,
          bytesBase64: await blobToBase64(thumbnail.blob)
        });
      }
    }
    return {
      pngs: wanted,
      manifest: bundle.manifest,
      stats: wall.stats
    };

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
  },
  base64
);

for (const png of sample.pngs) {
  await writeFile(join(outputDir, png.name), Buffer.from(png.bytesBase64, 'base64'));
}
await writeFile(
  join(outputDir, 'manifest.sample.json'),
  `${JSON.stringify(sample.manifest, null, 2)}\n`
);
await stopBrowser(handle);
console.log(`wrote ${sample.pngs.length} sample PNGs and manifest to ${outputDir}`);
console.log('stats', sample.stats);
