import {
  DEFAULT_TAPS,
  REFERENCE_FILE,
  REFERENCE_TAPS,
  TAP_OPTIONS,
} from './config.js';
import {
  buildGroupDelayCurve,
  buildTransientResidual,
  compareWithReference,
  computeWelchSpectrum,
} from './analysis.js';
import { resampleStereo } from './resampler.js';
import { generateInputSignal } from './signal.js';
import { decodeFloat32Wav } from './wav.js';

let inputSignal = null;
let referenceAudio = null;
let inputSpectrum = null;
let referenceSpectrum = null;

function getInputSignal() {
  if (!inputSignal) {
    inputSignal = generateInputSignal();
  }
  return inputSignal;
}

async function loadReference() {
  if (referenceAudio) {
    return referenceAudio;
  }
  const response = await fetch(REFERENCE_FILE);
  if (!response.ok) {
    throw new Error(`Reference file returned HTTP ${response.status}`);
  }
  const decoded = decodeFloat32Wav(await response.arrayBuffer());
  referenceAudio = decoded;
  return decoded;
}

async function convert(tapsPerPhase) {
  const input = getInputSignal();
  const startedAt = performance.now();
  const result = resampleStereo(input, tapsPerPhase);
  const outputLeft = Float32Array.from(result.left);
  const outputRight = Float32Array.from(result.right);
  let comparison = null;
  let referenceStatus = 'unavailable';
  let referenceFrames = 0;

  try {
    const reference = await loadReference();
    if (reference.frames !== input.frames * 160 / 147) {
      throw new Error('Reference frame count does not match the 160/147 ratio');
    }
    comparison = compareWithReference(
      { left: outputLeft, right: outputRight },
      reference,
    );
    referenceFrames = reference.frames;
    referenceStatus = 'ready';
  } catch (error) {
    referenceStatus = error instanceof Error ? error.message : String(error);
  }

  if (!inputSpectrum) {
    inputSpectrum = computeWelchSpectrum(input.left, input.sampleRate);
  }
  if (!referenceSpectrum && referenceAudio) {
    referenceSpectrum = computeWelchSpectrum(referenceAudio.left, referenceAudio.sampleRate);
  }

  const outputSpectrum = computeWelchSpectrum(outputLeft, result.sampleRate);
  const residual = referenceAudio
    ? buildTransientResidual({ left: outputLeft, right: outputRight }, referenceAudio)
    : null;
  const groupDelay = buildGroupDelayCurve(tapsPerPhase);
  const totalMs = performance.now() - startedAt;

  return {
    tapsPerPhase,
    outputLeft,
    outputRight,
    outputFrames: outputLeft.length,
    outputRate: result.sampleRate,
    inputFrames: result.inputFrames,
    renderMs: result.renderMs,
    totalMs,
    prototypeLength: result.prototypeLength,
    groupDelayMs: result.groupDelayMs,
    stereoSkewSamples: result.stereoSkewSamples,
    inputSpectrum,
    outputSpectrum,
    referenceSpectrum,
    groupDelay,
    comparison,
    residual,
    referenceStatus,
    referenceFrames,
    referenceTaps: REFERENCE_TAPS,
    availableTaps: TAP_OPTIONS,
    defaultTaps: DEFAULT_TAPS,
  };
}

self.onmessage = async (event) => {
  const { type, tapsPerPhase } = event.data ?? {};
  if (type !== 'convert') {
    return;
  }

  try {
    const payload = await convert(tapsPerPhase);
    const message = { type: 'result', payload };
    self.postMessage(message, [payload.outputLeft.buffer, payload.outputRight.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
