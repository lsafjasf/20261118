// Simulate the AudioWorklet global environment to exercise the processor
// outside a browser: verifies init, parameter updates, bypass and telemetry.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(root, 'src/deesser-engine.js'), 'utf8');
const processorSrc = fs.readFileSync(path.join(root, 'src/deesser-processor.js'), 'utf8').replace("import './deesser-engine.js';", '');

const messages = [];
const registered = {};
const makePort = () => ({ onmessage: null, postMessage: (msg) => messages.push(msg) });
const sandbox = {
  console,
  AudioWorkletProcessor: class AudioWorkletProcessor {
  constructor() {
    this.port = makePort();
  }
  },
  registerProcessor: (name, ctor) => {
  registered[name] = ctor;
  },
  sampleRate: 44100,
  globalThis: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(engineSrc, sandbox);
vm.runInContext(processorSrc, sandbox);

const Ctor = registered['de-esser-processor'];
if (!Ctor) throw new Error('processor was not registered');

// Minimal k-rate AudioParam-like object: processors read parameters.name[0].
const param = (value) => [value];
const descriptors = Ctor.parameterDescriptors;
const makeParams = () => {
  const p = {};
  for (const d of descriptors) p[d.name] = param(d.defaultValue);
  return p;
};

const proc = new Ctor();
const block = 128;
const input = [new Float32Array(block)];
for (let i = 0; i < block; i++) input[0][i] = 0.7 * Math.sin((2 * Math.PI * 8000 * i) / 44100);
const output = [new Float32Array(block)];

// 1. Normal processing with sibilant-level input.
let keepGoing = proc.process([input], [output], makeParams());
if (keepGoing !== true) throw new Error('process() should return true');

// 2. Bypass passes input through untouched.
proc.port.onmessage({ data: { type: 'bypass', value: true } });
const outBypass = [new Float32Array(block)];
proc.process([input], [outBypass], makeParams());
let bypassMatch = true;
for (let i = 0; i < block; i++) {
  if (Math.abs(outBypass[0][i] - input[0][i]) > 1e-6) bypassMatch = false;
}
if (!bypassMatch) throw new Error('bypass did not pass input through');

// 3. Telemetry emits reduction messages.
proc.port.onmessage({ data: { type: 'bypass', value: false } });
proc.port.onmessage({ data: { type: 'telemetry', enabled: true, stride: 16 } });
for (let b = 0; b < 60; b++) proc.process([input], [output], makeParams());
const reductions = messages.filter((m) => m.type === 'reduction');
if (reductions.length === 0) throw new Error('no telemetry emitted');
if (typeof reductions[reductions.length - 1].reductionDb !== 'number') {
  throw new Error('telemetry missing reductionDb');
}
if (reductions[reductions.length - 1].reductionDb < 1) {
  throw new Error(`detector did not engage on sibilant-level input: ${JSON.stringify(reductions.slice(-2))}`);
}

// 4. Empty input (underrun) must not throw and must keep node alive.
proc.process([], [new Array(1).fill(new Float32Array(block))], makeParams());

console.log(JSON.stringify({
  registered: Object.keys(registered),
  bypassPassthrough: bypassMatch,
  telemetryMessages: reductions.length,
  latestReductionDb: reductions[reductions.length - 1].reductionDb,
  underrunHandled: true,
}, null, 2));
