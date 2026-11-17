// Real WebGL2 verification through headless Chrome via Puppeteer.
// Runs the same four matrix/range combinations, the stride sweep, fixed
// pixel CPU comparison and the overshoot clamp-ordering check on GPU output.

import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { fixedPoints } from './cpu-tests.js';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8123';
const COMBOS = [
  ['bt601', 'limited'],
  ['bt601', 'full'],
  ['bt709', 'limited'],
  ['bt709', 'full'],
];

export async function runBrowserTests() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const results = { combos: [], strides: [], fixedPixels: [], clampOrder: null };
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !msg.text().includes('404')) {
        errors.push(msg.text());
      }
    });
    page.on('response', (res) => {
      if (!res.ok() && !res.url().includes('favicon.ico')) {
        errors.push(`HTTP ${res.status()} ${res.url()}`);
      }
    });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__yuvApp !== undefined');

    const glVendor = await page.evaluate(() => {
      const gl = document.getElementById('view').getContext('webgl2');
      return gl.getParameter(gl.VERSION);
    });
    results.glVersion = glVendor;

    for (const [matrix, range] of COMBOS) {
      const combo = await page.evaluate(([m, r]) => {
        const app = window.__yuvApp;
        app.setOvershoot(false);
        app.setCombination(m, r);
        const rgba = app.readRgba();
        const cpu = app.cpuRgb();
        const { WIDTH, HEIGHT, barIndexAt } = app.constants;
        const errs = app.colorBarErrors(rgba, WIDTH, HEIGHT, barIndexAt);
        const cmp = app.comparePixels(rgba, cpu, WIDTH, HEIGHT, []);
        return {
          name: `${m}/${r}`,
          worstBarError: Math.max(...errs.map((e) => e.maxAbs)),
          perBar: errs.map((e) => `${e.name}:${e.maxAbs}`),
          gpuVsCpuMax: cmp.globalMax,
        };
      }, [matrix, range]);
      assert.ok(combo.worstBarError <= 3, `${combo.name} bar error too high`);
      assert.ok(combo.gpuVsCpuMax <= 1, `${combo.name} GPU/CPU drift ${combo.gpuVsCpuMax}`);
      results.combos.push(combo);
    }

    // Fixed pixels: GPU output vs the CPU reference at the same coordinates.
    const fixed = await page.evaluate((points) => {
      const app = window.__yuvApp;
      const out = [];
      for (const [m, r] of [['bt601', 'limited'], ['bt709', 'full']]) {
        app.setCombination(m, r);
        const rgba = app.readRgba();
        const { WIDTH } = app.constants;
        for (const [px, py, name] of points) {
          const i = (py * WIDTH + px) * 4;
          out.push({
            combo: `${m}/${r}`,
            point: `${px},${py}`,
            bar: name,
            gpu: [rgba[i], rgba[i + 1], rgba[i + 2]],
            cpu: app.sampleCpu(px, py),
          });
        }
      }
      return out;
    }, fixedPoints);
    for (const row of fixed) {
      const diff = Math.max(...row.gpu.map((v, ch) => Math.abs(v - row.cpu[ch])));
      assert.ok(diff <= 1, `fixed pixel ${row.combo} ${row.point} diff ${diff}`);
      results.fixedPixels.push({ ...row, maxDiff: diff });
    }

    // Stride sweep: padded Y/UV strides must keep rows aligned and match CPU.
    const strideCases = [
      [322, 162],
      [352, 176],
      [400, 200],
      [331, 167],
    ];
    for (const [sy, sc] of strideCases) {
      const row = await page.evaluate(([y, c]) => {
        const app = window.__yuvApp;
        app.setOvershoot(false);
        app.setStrides(y, c);
        const rgba = app.readRgba();
        const cpu = app.cpuRgb();
        const { WIDTH, HEIGHT, barIndexAt } = app.constants;
        const misaligned = app.findMisalignedRow(rgba, WIDTH, HEIGHT, barIndexAt);
        const cmp = app.comparePixels(rgba, cpu, WIDTH, HEIGHT, []);
        return { sy: y, sc: c, misaligned, gpuVsCpuMax: cmp.globalMax };
      }, [sy, sc]);
      assert.equal(row.misaligned, null, `misaligned row at strides ${sy}/${sc}`);
      assert.ok(row.gpuVsCpuMax <= 1, 'strided frame GPU/CPU drift');
      results.strides.push(row);
    }

    // Clamp ordering on the GPU: overshoot must affect output but stay in 0-255.
    const clamp = await page.evaluate(() => {
      const app = window.__yuvApp;
      app.setCombination('bt601', 'limited');
      app.setOvershoot(false);
      const clean = app.readRgba().slice(0, 12);
      app.setOvershoot(true);
      const over = app.readRgba();
      const { yPlane, uPlane, vPlane, strides } = app.state.frame;
      const codes = [
        yPlane[5 * strides.y + 5],
        uPlane[2 * strides.c + 2],
        vPlane[2 * strides.c + 2],
      ];
      const topLeft = [over[0], over[1], over[2]];
      return {
        codes,
        topLeft,
        differsFromClean:
          JSON.stringify([over[0], over[1], over[2]]) !== JSON.stringify([clean[0], clean[1], clean[2]]),
        allInRange: topLeft.every((v) => v >= 0 && v <= 255),
      };
    });
    assert.deepEqual(clamp.codes, [250, 10, 250]);
    assert.ok(clamp.differsFromClean, 'overshoot did not reach GPU output');
    assert.ok(clamp.allInRange, 'GPU output left the 0-255 envelope');
    results.clampOrder = clamp;

    assert.equal(errors.length, 0, `page errors: ${errors.join(' | ')}`);
  } finally {
    await browser.close();
  }
  return results;
}
