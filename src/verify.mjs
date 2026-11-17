// End-to-end verification: compositor buffer vs PNG vs video frames,
// straight vs premultiplied input equivalence, and analytic expectations.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import {
  STRAIGHT,
  PREMULTIPLIED,
  compositePixel,
  renderFrame,
  blendOverBackground,
} from './compositor.mjs';
import { encodePng, decodePng } from './png.mjs';
import { makeScene, PROBES, BACKGROUND, WIDTH, HEIGHT } from './scene.mjs';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}` +
      (ok ? '' : `\n     expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`)
  );
}

function px(buf, x, y, w = WIDTH) {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

// --- 1. Analytic expectations for the 50%-alpha overlap sample -------------
console.log('== analytic pixel values (straight-alpha pipeline) ==');
const scene = makeScene(0);
const EXPECT_STRAIGHT = {
  empty: [0, 0, 0, 0],
  red: [255, 0, 0, 128],
  green: [0, 255, 0, 128],
  blue: [0, 0, 255, 128],
  redGreen: [85, 170, 0, 192],
  redBlue: [85, 0, 170, 192],
  greenBlue: [0, 85, 170, 192],
  redGreenBlue: [36, 73, 146, 224],
};
const EXPECT_ON_BG = {
  empty: [255, 255, 255],
  red: [255, 127, 127],
  green: [127, 255, 127],
  blue: [127, 127, 255],
  redGreen: [127, 191, 63],
  redBlue: [127, 63, 191],
  greenBlue: [63, 127, 191],
  redGreenBlue: [63, 95, 159],
};
for (const [name, [x, y]] of Object.entries(PROBES)) {
  const { finalPremul, finalStraight } = compositePixel(scene.layers, x, y, STRAIGHT);
  check(`straight ${name} (${x},${y})`, finalStraight, EXPECT_STRAIGHT[name]);
  check(`on-bg   ${name} (${x},${y})`, blendOverBackground(finalPremul, BACKGROUND), EXPECT_ON_BG[name]);
}

// --- 2. Straight vs premultiplied input must render identically ------------
console.log('== representation toggle: straight vs premultiplied ==');
const frameStraight = renderFrame(scene, STRAIGHT);
const framePremul = renderFrame(scene, PREMULTIPLIED);
check('full-frame buffers identical', Buffer.from(framePremul.straight).equals(Buffer.from(frameStraight.straight)), true);
check('premul buffers identical', Buffer.from(framePremul.premul).equals(Buffer.from(frameStraight.premul)), true);

// --- 3. PNG round-trip equals the compositor buffer ------------------------
console.log('== PNG export ==');
const png = encodePng(WIDTH, HEIGHT, frameStraight.straight);
fs.writeFileSync('out/result.png', png);
const decoded = decodePng(png);
check('png size', [decoded.width, decoded.height], [WIDTH, HEIGHT]);
check('png pixels == compositor buffer', Buffer.from(decoded.rgba).equals(Buffer.from(frameStraight.straight)), true);
// Cross-check with ffmpeg's own PNG decoder.
const ffPng = execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', 'out/result.png', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
check('ffmpeg png decode == compositor buffer', ffPng.equals(Buffer.from(frameStraight.straight)), true);

// --- 4. Video frames round-trip --------------------------------------------
console.log('== video export (qtrle lossless RGBA) ==');
const NFRAMES = 6;
const allFrames = Buffer.concat(
  Array.from({ length: NFRAMES }, (_, f) => Buffer.from(renderFrame(makeScene(f), STRAIGHT).straight))
);
execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${WIDTH}x${HEIGHT}`, '-framerate', '12', '-i', 'pipe:0', '-c:v', 'qtrle', '-pix_fmt', 'rgba', 'out/result.mov'], { input: allFrames });
const decodedVideo = execFileSync(ffmpeg, ['-v', 'error', '-i', 'out/result.mov', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
check('video byte count', decodedVideo.length, allFrames.length);
check('video frames == compositor buffers', decodedVideo.equals(allFrames), true);
for (const [name, [x, y]] of Object.entries(PROBES)) {
  check(`video frame0 ${name}`, px(decodedVideo, x, y), EXPECT_STRAIGHT[name]);
}

// --- 5. Per-step dump of one pixel (same data the UI inspector shows) ------
console.log('== per-step RGBA at redGreenBlue probe (50,30) ==');
const { steps, finalPremul, finalStraight } = compositePixel(scene.layers, 50, 30, STRAIGHT);
for (const s of steps) {
  console.log(
    `  layer ${s.layer.name.padEnd(5)} input=${JSON.stringify(s.input)} premul=${JSON.stringify(s.premul)} acc=${JSON.stringify(s.acc)}`
  );
}
console.log(`  final premul=${JSON.stringify(finalPremul)} straight=${JSON.stringify(finalStraight)} on-white-bg=${JSON.stringify(blendOverBackground(finalPremul, BACKGROUND))}`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
