// Generates a synthetic test video with three segments:
//   A (0-4s)   : slow motion scene
//   hard cut at 4.0s
//   B (4-8s)   : warm scene, fades out to black over 7-8s
//   black 8-9s
//   C (9-15s)  : fast motion scene, fades in from black over 9-10s
// Ground truth boundaries: hard cut @4.0s, gradual @7-8s, gradual @9-10s.
// Scene C contains continuous fast motion that must NOT trigger cuts.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');

const W = 640;
const H = 360;
const FPS = 30;
const DUR = 15;
const TOTAL = DUR * FPS;

const frame = Buffer.alloc(W * H * 3);

function fillBackground(t, scene) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const gy = y / H;
      const gx = x / W;
      if (scene === 'A') {
        const drift = 0.08 * Math.sin(t * 0.6 + gy * 3);
        frame[i] = 20 + 30 * gy + 20 * drift;
        frame[i + 1] = 40 + 50 * gy;
        frame[i + 2] = 110 + 60 * gy + 30 * drift;
      } else if (scene === 'B') {
        frame[i] = 150 + 70 * gy;
        frame[i + 1] = 60 + 40 * gx;
        frame[i + 2] = 30 + 20 * gy;
      } else {
        const stripe = (Math.floor(x / 40) % 2) * 18;
        frame[i] = 25 + stripe;
        frame[i + 1] = 110 + 50 * gy;
        frame[i + 2] = 80 + stripe + 30 * (1 - gy);
      }
    }
  }
}

function drawDisc(cx, cy, r, rgb) {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * W + x) * 3;
        frame[i] = rgb[0];
        frame[i + 1] = rgb[1];
        frame[i + 2] = rgb[2];
      }
    }
  }
}

function drawRect(rx, ry, w, h, rgb) {
  const xa = Math.max(0, Math.round(rx));
  const ya = Math.max(0, Math.round(ry));
  const xb = Math.min(W, Math.round(rx + w));
  const yb = Math.min(H, Math.round(ry + h));
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 3;
      frame[i] = rgb[0];
      frame[i + 1] = rgb[1];
      frame[i + 2] = rgb[2];
    }
  }
}
function sceneA(t) {
  fillBackground(t, 'A');
  drawDisc(120 + 25 * t, 130 + 8 * Math.sin(t), 34, [235, 220, 180]);
  drawDisc(430 - 15 * t, 230 + 10 * Math.cos(t * 0.7), 26, [180, 200, 240]);
  drawRect(280 + 10 * t, 60, 60, 40, [90, 130, 200]);
}

function sceneB(t) {
  fillBackground(t, 'B');
  for (let k = 0; k < 4; k++) {
    const x = ((k * 190 + t * 55) % (W + 120)) - 60;
    drawRect(x, 40 + k * 70, 46, 46, [250, 200 - k * 30, 90 + k * 20]);
  }
  drawDisc(500 - 20 * t, 280, 30, [250, 240, 230]);
}

function sceneC(t) {
  fillBackground(t, 'C');
  for (let k = 0; k < 5; k++) {
    const sp = 260 + k * 90;
    const x = Math.abs(((t * sp + k * 137) % (2 * (W - 60))) - (W - 60)) + 10;
    const ysp = 200 + k * 60;
    const y = Math.abs(((t * ysp + k * 89) % (2 * (H - 60))) - (H - 60)) + 10;
    drawRect(x, y, 44, 44, [240 - k * 30, 240, 120 + k * 25]);
  }
  drawDisc(320 + 240 * Math.sin(t * 5), 180 + 120 * Math.cos(t * 4.2), 22, [255, 120, 220]);
}

function applyBrightness(f) {
  for (let i = 0; i < frame.length; i++) frame[i] = Math.round(frame[i] * f);
}

function renderFrame(n) {
  const t = n / FPS;
  if (t < 4) {
    sceneA(t);
  } else if (t < 8) {
    sceneB(t - 4);
    if (t >= 7) applyBrightness(Math.max(0, 8 - t));
  } else if (t < 9) {
    frame.fill(0);
  } else {
    sceneC(t - 9);
    if (t < 10) applyBrightness(Math.min(1, t - 9));
  }
  return frame;
}

async function encode(out, codecArgs) {
  const args = [
      '-y',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-s', `${W}x${H}`,
      '-r', String(FPS),
      '-i', 'pipe:0',
      '-an',
      ...codecArgs,
      out,
  ];
  const p = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}`))));
  });
  for (let n = 0; n < TOTAL; n++) {
      // copy: the shared frame buffer is mutated on the next iteration
      const chunk = Buffer.from(renderFrame(n));
      if (!p.stdin.write(chunk)) {
        await new Promise((r) => p.stdin.once('drain', r));
      }
  }
  p.stdin.end();
  await done;
}

const mode = process.argv[2] || 'all';
if (mode === 'all' || mode === 'h264') {
  await encode('assets/test-video.mp4', [
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20',
    '-g', '60', '-movflags', '+faststart',
  ]);
  console.log('wrote assets/test-video.mp4 (h264)');
}
if (mode === 'all' || mode === 'vp9') {
  await encode('assets/test-video-vp9.mp4', [
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '2M', '-g', '60',
    '-movflags', '+faststart',
  ]);
  console.log('wrote assets/test-video-vp9.mp4 (vp9)');
}
