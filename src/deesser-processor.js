// AudioWorklet node wrapping the shared DeEsser engine.
// Parameters (also live-updatable via port message {type:'params', ...}):
//   crossoverFreq  Hz  - sibilance band start
//   thresholdDb    dB  - high-band trigger threshold
//   maxReductionDb dB  - maximum attenuation
//   releaseMs      ms  - recovery speed
import './deesser-engine.js';

class DeEsserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
  return [
    { name: 'crossoverFreq', defaultValue: 5000, minValue: 500, maxValue: 16000, automationRate: 'k-rate' },
    { name: 'thresholdDb', defaultValue: -20, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
    { name: 'maxReductionDb', defaultValue: 10, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
    { name: 'releaseMs', defaultValue: 80, minValue: 10, maxValue: 2000, automationRate: 'k-rate' },
  ];
  }

  constructor() {
  super();
  this.engine = null;
  this.bypass = false;
  this.telemetry = false;
  this.telemetryStride = 32;
  this.totalFrames = 0;
  this.blocksSinceTelemetry = 0;
  this.telemetryIntervalBlocks = 8;
  this.port.onmessage = (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'bypass') this.bypass = !!msg.value;
    if (msg.type === 'telemetry') {
    this.telemetry = !!msg.enabled;
    this.telemetryStride = msg.stride || 32;
    if (this.engine) {
      this.engine.enableReductionRecording(4096, this.telemetryStride);
    }
    }
  };
  }

  process(inputs, outputs, parameters) {
  const input = inputs[0];
  const output = outputs[0];
  if (!input || input.length === 0) return true;
  const channels = input.length;
  if (!this.engine || this.engine.channels !== channels) {
    this.engine = new globalThis.DeEsser(sampleRate, {
    crossoverFreq: parameters.crossoverFreq[0],
    thresholdDb: parameters.thresholdDb[0],
    maxReductionDb: parameters.maxReductionDb[0],
    releaseMs: parameters.releaseMs[0],
    }, channels);
    this.engine.enableReductionRecording(4096, this.telemetryStride);
  }
  this.engine.setParams({
    crossoverFreq: parameters.crossoverFreq[0],
    thresholdDb: parameters.thresholdDb[0],
    maxReductionDb: parameters.maxReductionDb[0],
    releaseMs: parameters.releaseMs[0],
  });

  if (this.bypass) {
    for (let c = 0; c < channels; c++) output[c].set(input[c]);
    return true;
  }

  this.engine.process(input, output);
  this.totalFrames += input[0].length;

  if (this.telemetry && ++this.blocksSinceTelemetry >= this.telemetryIntervalBlocks) {
  this.blocksSinceTelemetry = 0;
    const curve = this.engine.getReductionCurve();
    if (curve && curve.length > 0) {
    this.port.postMessage(
      {
      type: 'reduction',
      reductionDb: this.engine.reductionDb,
      stride: this.telemetryStride,
      curve: Array.from(curve),
      frame: this.totalFrames,
      },
      undefined,
    );
    }
    this.engine.recordIdx = 0;
  }
  return true;
  }
}

registerProcessor('de-esser-processor', DeEsserProcessor);
