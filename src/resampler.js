import {
  DECIMATION,
  INPUT_RATE,
  INTERPOLATION,
  KAISER_BETA,
  OUTPUT_RATE,
} from './config.js';

function besselI0(value) {
  let sum = 1;
  let term = 1;
  const half = value * value / 4;

  for (let order = 1; order < 32; order += 1) {
    term *= half / (order * order);
    sum += term;
    if (term < sum * 1e-14) {
      break;
    }
  }

  return sum;
}

function sinc(value) {
  if (Math.abs(value) < 1e-12) {
    return 1;
  }
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function kaiser(value, halfWidth, beta) {
  const ratio = value / halfWidth;
  if (Math.abs(ratio) > 1) {
    return 0;
  }
  return besselI0(beta * Math.sqrt(1 - ratio * ratio)) / besselI0(beta);
}

export function expectedOutputFrames(inputFrames) {
  return Math.round(inputFrames * INTERPOLATION / DECIMATION);
}

export function designPolyphase(tapsPerPhase, beta = KAISER_BETA) {
  if (!Number.isInteger(tapsPerPhase) || tapsPerPhase < 8 || tapsPerPhase % 2 !== 0) {
    throw new Error('tapsPerPhase must be an even integer of at least 8');
  }

  const halfWidth = tapsPerPhase / 2;
  const coefficients = new Float64Array(INTERPOLATION * tapsPerPhase);
  const phaseStarts = new Int16Array(INTERPOLATION);
  const phaseGains = new Float64Array(INTERPOLATION);

  for (let phase = 0; phase < INTERPOLATION; phase += 1) {
    const fraction = phase / INTERPOLATION;
    const firstOffset = Math.ceil(fraction - halfWidth);
    const phaseBase = phase * tapsPerPhase;
    let sum = 0;

    phaseStarts[phase] = firstOffset;

    for (let tap = 0; tap < tapsPerPhase; tap += 1) {
      const offset = firstOffset + tap;
      const distance = fraction - offset;
      const weight = sinc(distance) * kaiser(distance, halfWidth, beta);
      coefficients[phaseBase + tap] = weight;
      sum += weight;
    }

    if (Math.abs(sum) > 1e-12) {
      for (let tap = 0; tap < tapsPerPhase; tap += 1) {
        coefficients[phaseBase + tap] /= sum;
      }
    }
    phaseGains[phase] = sum;
  }

  return {
    tapsPerPhase,
    beta,
    halfWidth,
    coefficients,
    phaseStarts,
    phaseGains,
    interpolation: INTERPOLATION,
    decimation: DECIMATION,
    prototypeLength: INTERPOLATION * tapsPerPhase,
    groupDelaySeconds: halfWidth / INPUT_RATE,
  };
}

export function resampleStereo(signal, tapsPerPhase, beta = KAISER_BETA) {
  const design = designPolyphase(tapsPerPhase, beta);
  const inputLeft = signal.left;
  const inputRight = signal.right;
  const inputFrames = inputLeft.length;
  const outputFrames = expectedOutputFrames(inputFrames);
  const outputLeft = new Float64Array(outputFrames);
  const outputRight = new Float64Array(outputFrames);
  const { coefficients, phaseStarts } = design;
  const startTime = performance.now();

  for (let frame = 0; frame < outputFrames; frame += 1) {
    const phase = (frame * DECIMATION) % INTERPOLATION;
    const inputBase = Math.floor(frame * DECIMATION / INTERPOLATION);
    const firstOffset = phaseStarts[phase];
    const coefficientBase = phase * tapsPerPhase;
    const relativeStart = inputBase + firstOffset;
    const tapStart = Math.max(0, -relativeStart);
    const tapEnd = Math.min(tapsPerPhase, inputFrames - relativeStart);
    let left = 0;
    let right = 0;

    for (let tap = tapStart; tap < tapEnd; tap += 1) {
      const coefficient = coefficients[coefficientBase + tap];
      const inputIndex = relativeStart + tap;
      left += inputLeft[inputIndex] * coefficient;
      right += inputRight[inputIndex] * coefficient;
    }

    outputLeft[frame] = left;
    outputRight[frame] = right;
  }

  const renderMs = performance.now() - startTime;

  return {
    left: outputLeft,
    right: outputRight,
    inputFrames,
    outputFrames,
    sampleRate: OUTPUT_RATE,
    duration: outputFrames / OUTPUT_RATE,
    renderMs,
    tapCount: tapsPerPhase,
    prototypeLength: design.prototypeLength,
    groupDelayMs: design.groupDelaySeconds * 1000,
    stereoSkewSamples: measureStereoSkew(
      outputLeft,
      outputRight,
      1.8 * OUTPUT_RATE,
      OUTPUT_RATE,
    ),
  };
}

export function measureStereoSkew(left, right, centerSample, sampleRate) {
  const radius = Math.round(sampleRate * 0.02);
  const start = Math.max(radius, Math.floor(centerSample - sampleRate * 0.06));
  const end = Math.min(left.length - radius, Math.ceil(centerSample + sampleRate * 0.06));
  let bestLag = 0;
  let bestScore = -Infinity;

  for (let lag = -8; lag <= 8; lag += 1) {
    let score = 0;
    for (let index = start; index < end; index += 1) {
      score += left[index] * right[index + lag];
    }
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  return bestLag;
}

export function peakAround(channel, centerSample, radius) {
  const start = Math.max(0, Math.floor(centerSample - radius));
  const end = Math.min(channel.length, Math.ceil(centerSample + radius + 1));
  let peakIndex = start;
  let peakValue = 0;

  for (let index = start; index < end; index += 1) {
    const magnitude = Math.abs(channel[index]);
    if (magnitude > peakValue) {
      peakValue = magnitude;
      peakIndex = index;
    }
  }

  return { index: peakIndex, value: peakValue };
}
