// Edge-case unit tests driven directly against the WASM module.
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { Declicker } = require('../src/declicker');

async function main() {
  const declicker = await Declicker.create(
    path.resolve(__dirname, '..', 'build', 'declicker.wasm')
  );

  // 1. Inputs shorter than the analysis window are returned untouched.
  {
    const tiny = new Float32Array(8).fill(0.5);
    const { output, regions, modified } = declicker.process(tiny, 0);
    assert.strictEqual(modified, 0);
    assert.strictEqual(regions.length, 0);
    assert.deepStrictEqual(Array.from(output), Array.from(tiny));
    console.log('ok  short input untouched');
  }

  // 2. Silence stays silence (no false positives, no NaN).
  {
    const silence = new Float32Array(4096);
    const { output, regions } = declicker.process(silence, 0);
    assert.strictEqual(regions.length, 0);
    assert.ok(output.every((v) => v === 0 && Number.isFinite(v)));
    console.log('ok  silence has no false positives');
  }

  // 3. A drum-like sustained transient alone must not be flagged.
  {
    const n = 4096;
    const sig = new Float32Array(n);
    const d0 = 2048;
    for (let k = 0; k < 600; k++) {
      const t = k / 48000;
      // Tail fade-out avoids a hard truncation, which itself would be a click.
      const tail = k > 480 ? Math.max(0, 1 - (k - 480) / 120) : 1;
      sig[d0 + k] = Math.min(1, k / 96) * Math.exp(-t / 0.08) *
        (0.6 * Math.sin(2 * Math.PI * 75 * t)) * tail;
    }
    const before = sig.slice();
    const { output, regions } = declicker.process(sig, 0);
    assert.strictEqual(regions.length, 0, 'drum transient flagged');
    assert.deepStrictEqual(Array.from(output), Array.from(before));
    console.log('ok  isolated drum transient preserved');
  }

  // 4. A click away from the edges is detected and flattened.
  {
    const n = 4096;
    const sig = new Float32Array(n);
    for (let i = 0; i < n; i++) sig[i] = 0.01 * Math.sin(i * 0.05);
    sig[1000] = 0.9;
    const { output, regions, modified } = declicker.process(sig, 0);
    assert.strictEqual(regions.length, 1);
    assert.ok(modified >= 3);
    assert.ok(Math.abs(output[1000]) < 0.1, 'spike not removed');
    console.log('ok  isolated click repaired');
  }

  // 5. Idempotence: running twice changes nothing the second time.
  {
    const n = 4096;
    const sig = new Float32Array(n);
    sig[500] = -0.8;
    const first = declicker.process(sig, 0).output;
    const second = declicker.process(first, 0);
    assert.strictEqual(second.regions.length, 0);
    assert.deepStrictEqual(Array.from(second.output), Array.from(first));
    console.log('ok  second pass is a no-op');
  }

  console.log('\nall unit tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
