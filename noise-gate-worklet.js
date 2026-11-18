// noise-gate-worklet.js — AudioWorkletProcessor wrapping the shared
// SpectralGate DSP core. All sample processing happens here on the audio
// rendering thread; the main thread only receives telemetry.
import { SpectralGate, DEFAULT_PARAMS } from './dsp.js';

class SpectralNoiseGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gate = new SpectralGate({ sampleRate });
    this.params_ = { ...DEFAULT_PARAMS };
    this.telemetryCounter = 0;
    // ~10 Hz telemetry at 128-sample quanta.
    this.telemetryInterval = Math.max(1, Math.round(sampleRate / 128 / 10));
    // Render-clock drift tracking: currentFrame advances exactly 128 per
    // quantum; any skipped quantum shows up here as accumulated drift.
    this.firstFrame = -1;
    this.quanta = 0;
    this.renderDriftFrames = 0;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg && msg.type === 'params') {
        Object.assign(this.params_, msg.params);
        this.gate.setParams(this.params_);
      } else if (msg && msg.type === 'telemetry-request') {
        this.postTelemetry();
      }
    };
  }

  postTelemetry() {
    const t = this.gate.getTelemetry();
    this.port.postMessage({ type: 'telemetry', ...t, driftFrames: this.renderDriftFrames });
  }

  process(inputs, outputs) {
    if (this.firstFrame < 0) {
      this.firstFrame = currentFrame;
    }
    this.quanta++;
    this.renderDriftFrames = (currentFrame - this.firstFrame) - (this.quanta - 1) * 128;
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0) {
      return true;
    }
    const src = input[0];
    const dst = output[0];
    if (src && dst) {
      this.gate.process(src, dst);
      // Mirror the processed mono signal to any remaining channels.
      for (let ch = 1; ch < output.length; ch++) {
        output[ch].set(dst);
      }
    }
    this.telemetryCounter++;
    if (this.telemetryCounter >= this.telemetryInterval) {
      this.telemetryCounter = 0;
      this.postTelemetry();
    }
    return true;
  }
}

registerProcessor('spectral-noise-gate', SpectralNoiseGateProcessor);
