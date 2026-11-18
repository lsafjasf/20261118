// Measure high-band levels per segment to pick a trigger threshold.
'use strict';

const fs = require('fs');
const path = require('path');
const { BiquadHighPass } = require('../src/deesser-engine.js');
const { readWav } = require('./wav-codec');

const root = path.join(__dirname, '..');
const buf = fs.readFileSync(path.join(root, 'artifacts/test-voice.wav'));
const wav = readWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const meta = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/test-voice-segments.json'), 'utf8'));
const x = wav.channels[0];
const sr = wav.sampleRate;

for (const fc of [4000, 5000, 6500, 8000]) {
  const hp = new BiquadHighPass(sr, fc);
  const high = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) high[i] = hp.process(x[i]);
  console.log(`\n== high-pass crossover ${fc} Hz (segment RMS / peak in dBFS) ==`);
  for (const seg of meta.segments) {
  let sum = 0;
  let peak = 0;
  for (let i = seg.start; i < seg.end; i++) {
    sum += high[i] * high[i];
    peak = Math.max(peak, Math.abs(high[i]));
  }
  const rms = Math.sqrt(sum / (seg.end - seg.start));
  console.log(
    `${seg.label.padEnd(16)} ${seg.kind.padEnd(10)} rms ${(20 * Math.log10(rms + 1e-9)).toFixed(1).padStart(6)}  peak ${(20 * Math.log10(peak + 1e-9)).toFixed(1).padStart(6)}`,
  );
  }
}
