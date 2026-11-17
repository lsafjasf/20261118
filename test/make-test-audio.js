// Generates a deterministic 48 kHz mono test signal containing:
//   - a soft musical bed (two detuned sine partials + gentle noise floor),
//   - three artificial clicks/pops of different shapes,
//   - one real drum-style transient (fast attack, decaying resonant body)
//     that the detector must leave untouched.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeWavPcm16 } = require('../src/wav-codec');

const SAMPLE_RATE = 48000;
const DURATION = 1.0;
const N = SAMPLE_RATE * DURATION;

// Known ground-truth event positions (sample indices), asserted by the test.
const EVENTS = {
  clickSingle: 9600,   // 200 ms : one-sample full-scale impulse
  clickDip: 19200,     // 400 ms : 3-sample negative spike
  clickBuzz: 28800,    // 600 ms : 7-sample alternating buzz
  drumHit: 38400,      // 800 ms : real kick-like transient
};

function makeSignal() {
  const x = new Float32Array(N);
  // Musical bed: 220 Hz + 330 Hz partials, slow tremolo, tiny noise floor.
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    const trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 3 * t);
    x[i] =
      trem *
        (0.12 * Math.sin(2 * Math.PI * 220 * t) +
          0.07 * Math.sin(2 * Math.PI * 330 * t + 0.6)) +
      0.0015 * (Math.random() * 2 - 1);
  }

  // Click 1: single full-scale sample (classic digital pop).
  x[EVENTS.clickSingle] = 0.95;

  // Click 2: short negative dip over 3 samples (needle scratch style).
  x[EVENTS.clickDip - 1] = -0.42;
  x[EVENTS.clickDip] = -0.88;
  x[EVENTS.clickDip + 1] = -0.4;

  // Click 3: 7-sample alternating high-frequency buzz.
  for (let k = 0; k < 7; k++) {
    x[EVENTS.clickBuzz + k] = (k % 2 === 0 ? 1 : -1) * 0.7 * (1 - k / 8);
  }

  // Drum hit: 2 ms attack into an ~80 ms exponentially decaying 75 Hz body
  // with a few harmonics. Energy stays high after the onset, unlike a click.
  const d0 = EVENTS.drumHit;
  const decay = 0.08; // seconds
  for (let k = 0; k < SAMPLE_RATE * 0.12; k++) {
    const t = k / SAMPLE_RATE;
    const attack = Math.min(1, k / (0.002 * SAMPLE_RATE));
    const env = attack * Math.exp(-t / decay);
    const body =
      0.55 * Math.sin(2 * Math.PI * 75 * t) +
      0.22 * Math.sin(2 * Math.PI * 150 * t + 0.4) +
      0.1 * Math.sin(2 * Math.PI * 230 * t + 1.1);
    x[d0 + k] += env * body;
  }
  return x;
}

function main() {
  const samples = makeSignal();
  const outDir = path.resolve(__dirname, '..', 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const wav = encodeWavPcm16(samples, SAMPLE_RATE);
  const outPath = path.join(outDir, 'test-input.wav');
  fs.writeFileSync(outPath, wav);
  fs.writeFileSync(
    path.join(outDir, 'test-events.json'),
    JSON.stringify({ sampleRate: SAMPLE_RATE, events: EVENTS }, null, 2)
  );
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${wav.length} bytes, ${samples.length} samples)`);
}

if (require.main === module) main();
module.exports = { makeSignal, EVENTS, SAMPLE_RATE };
