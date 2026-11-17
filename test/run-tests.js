// Entry point: starts the static server, runs CPU tests, then WebGL2 tests.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runCpuTests } from './cpu-tests.js';

const section = (title) => {
  console.log(`\n=== ${title} ===`);
};

async function withServer(fn) {
  const port = 8200 + Math.floor(Math.random() * 200);
  process.env.BASE_URL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(port) },
  });
  let started = false;
  server.stdout.on('data', (chunk) => {
    if (chunk.includes('serving on')) started = true;
  });
  for (let i = 0; i < 50 && !started; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!started) throw new Error('static server failed to start');
  try {
    return await fn();
  } finally {
    server.kill();
    await once(server, 'exit').catch(() => {});
  }
}

async function main() {
  section('CPU reference tests (Node)');
  const cpu = runCpuTests();
  for (const c of cpu.combos) {
    console.log(`  ${c.combo.padEnd(14)} worst bar error=${c.worstBarError}`);
  }
  console.log(`  strides: ${cpu.stride.cases.length} layouts, ${cpu.stride.status}`);
  console.log(`  clamp ordering: raw=${cpu.clampOrder.rawOvershootRgb} preclamped=${cpu.clampOrder.preClampedRgb}`);
  console.log(`  fixed pixel rows: ${cpu.fixedPixels.length}`);

  section('WebGL2 browser tests (headless Chrome)');
  const browser = await withServer(async () => {
    const { runBrowserTests } = await import('./browser-tests.js');
    return runBrowserTests();
  });
  console.log(`  GL: ${browser.glVersion}`);
  for (const c of browser.combos) {
    console.log(
      `  ${c.name.padEnd(14)} barErr=${c.worstBarError} gpuVsCpuMax=${c.gpuVsCpuMax}`,
    );
  }
  for (const s of browser.strides) {
    console.log(
      `  stride Y=${s.sy} UV=${s.sc} misaligned=${s.misaligned} gpuVsCpuMax=${s.gpuVsCpuMax}`,
    );
  }
  console.log(`  fixed pixel GPU/CPU rows: ${browser.fixedPixels.length}`);
  const worstFixed = Math.max(...browser.fixedPixels.map((r) => r.maxDiff));
  console.log(`  fixed pixel worst diff: ${worstFixed}`);
  console.log(
    `  clamp ordering: codes=${browser.clampOrder.codes} gpu=${browser.clampOrder.topLeft} ` +
      `differs=${browser.clampOrder.differsFromClean} clamped=${browser.clampOrder.allInRange}`,
  );

  section('ALL TESTS PASSED');
}

main().catch((err) => {
  console.error('\nTEST FAILURE:', err.message);
  process.exitCode = 1;
});
