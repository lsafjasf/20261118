// Compares the hand-written WASM module against the C reference
// implementation on the same raw f32 signal. Region boundaries must match
// exactly and repaired samples must agree within f32 rounding.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const { Declicker } = require('../src/declicker');
const { decodeWav } = require('../src/wav-codec');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'artifacts');

async function main() {
  const wav = fs.readFileSync(path.join(ART, 'test-input.wav'));
  const { samples } = decodeWav(wav.buffer.slice(wav.byteOffset));
  const n = samples.length;
  const rawIn = path.join(ART, 'cross-in.f32');
  const rawOut = path.join(ART, 'cross-out.f32');
  fs.writeFileSync(rawIn, Buffer.from(samples.buffer, samples.byteOffset, n * 4));

  const declicker = await Declicker.create(path.join(ROOT, 'build', 'declicker.wasm'));
  let failures = 0;

  for (const mode of [0, 1]) {
    const stdout = execFileSync(
      path.join(ROOT, 'build', 'reference'),
      [String(mode), rawIn, rawOut, String(n)],
      { encoding: 'utf8' }
    );
    const cRegions = stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.split(' ').map(Number));
    const { output, regions } = declicker.process(samples, mode);
    assert.deepStrictEqual(regions, cRegions, `mode ${mode}: regions differ`);

    const cOut = new Float32Array(
      fs.readFileSync(rawOut).buffer.slice(0, n * 4)
    );
    let maxDiff = 0;
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(output[i] - cOut[i]));
    assert.ok(maxDiff < 1e-6, `mode ${mode}: sample mismatch ${maxDiff}`);
    console.log(`mode ${mode}: ${regions.length} regions match, max |wasm-c| = ${maxDiff.toExponential(1)}`);
  }
  fs.rmSync(rawIn, { force: true });
  fs.rmSync(rawOut, { force: true });
  console.log(failures === 0 ? 'C/WASM cross-check OK' : 'cross-check FAILED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
