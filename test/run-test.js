// End-to-end pipeline test for the WASM declicker:
//   1. decode the generated WAV (JS side),
//   2. run the WebAssembly module on the raw PCM,
//   3. assert the three clicks are repaired and the drum onset is preserved,
//   4. write repaired WAVs and a before/after waveform SVG,
//   5. print peak levels, modified-sample counts and timing.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const { Declicker } = require('../src/declicker');
const { decodeWav, encodeWavPcm16, encodeWavFloat32 } = require('../src/wav-codec');
const { renderWaveformSvg } = require('../src/waveform');
const { EVENTS } = require('./make-test-audio');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'artifacts');

function peak(x) {
  let m = 0;
  for (const v of x) {
    const a = Math.abs(v);
    if (a > m) m = a;
  }
  return m;
}

// Largest |step| between adjacent samples — the perceptually relevant click
// metric; pops are discontinuities even when absolute peak stays bounded.
function peakStep(x) {
  let m = 0;
  for (let i = 1; i < x.length; i++) {
    const a = Math.abs(x[i] - x[i - 1]);
    if (a > m) m = a;
  }
  return m;
}

function covers(regions, idx) {
  return regions.some(([lo, hi]) => idx >= lo && idx < hi);
}

async function main() {
  const wasmPath = path.join(ROOT, 'build', 'declicker.wasm');
  const inputWav = fs.readFileSync(path.join(ART, 'test-input.wav'));
  const decoded = decodeWav(inputWav.buffer.slice(inputWav.byteOffset));
  assert.strictEqual(decoded.sampleRate, 48000, 'sample rate must be 48 kHz');
  const before = decoded.samples;

  const declicker = await Declicker.create(wasmPath);
  console.log(`WASM module version: ${declicker.version()}`);

  const modeName = process.argv[2] === 'mirror' ? 'mirror' : 'linear';
  const mode = modeName === 'mirror' ? 1 : 0;
  const { output: after, regions, modified, ns } = declicker.process(before, mode);

  // ---- assertions ------------------------------------------------------
  for (const name of ['clickSingle', 'clickDip', 'clickBuzz']) {
    assert.ok(covers(regions, EVENTS[name]), `missing repair region for ${name}`);
  }
  assert.ok(!covers(regions, EVENTS.drumHit), 'drum onset must not be flagged');

  // Drum attack samples must remain essentially intact.
  const drumDiff = Math.abs(after[EVENTS.drumHit + 2] - before[EVENTS.drumHit + 2]);
  assert.ok(drumDiff < 0.02, `drum attack altered by ${drumDiff.toFixed(4)}`);

  // ---- artifacts -------------------------------------------------------
  fs.writeFileSync(path.join(ART, `test-output-${modeName}-16bit.wav`),
    encodeWavPcm16(after, 48000));
  fs.writeFileSync(path.join(ART, `test-output-${modeName}-float32.wav`),
    encodeWavFloat32(after, 48000));
  fs.writeFileSync(path.join(ART, `waveform-${modeName}.svg`),
    renderWaveformSvg({ before, after, regions, sampleRate: 48000 }));

  // ---- report ----------------------------------------------------------
  const lines = [];
  lines.push(`mode                 : ${modeName}`);
  lines.push(`samples              : ${before.length} (1.000 s @ 48000 Hz mono)`);
  lines.push(`peak before          : ${peak(before).toFixed(6)}`);
  lines.push(`peak after           : ${peak(after).toFixed(6)}`);
  lines.push(`peak |step| before   : ${peakStep(before).toFixed(6)}`);
  lines.push(`peak |step| after    : ${peakStep(after).toFixed(6)}`);
  lines.push(`repaired regions     : ${regions.length}`);
  lines.push(`modified samples     : ${modified}`);
  lines.push(`wasm processing time : ${ns} ns (${(ns / 1000).toFixed(2)} us)`);
  lines.push('regions (start..end, time):');
  for (const [lo, hi] of regions) {
    lines.push(`  [${String(lo).padStart(6)} .. ${String(hi).padStart(6)}) ` +
      `${(lo / 48000 * 1000).toFixed(2)} ms .. ${(hi / 48000 * 1000).toFixed(2)} ms ` +
      `(${hi - lo} samples)`);
  }
  const report = lines.join('\n');
  console.log(report);
  fs.writeFileSync(path.join(ART, `report-${modeName}.txt`), report + '\n');

  // Machine-readable summary for cross-checks.
  const summary = {
    mode: modeName,
    peakBefore: peak(before),
    peakAfter: peak(after),
    peakStepBefore: peakStep(before),
    peakStepAfter: peakStep(after),
    regionCount: regions.length,
    modifiedSamples: modified,
    processingNs: ns,
    regions,
  };
  fs.writeFileSync(path.join(ART, `summary-${modeName}.json`), JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
