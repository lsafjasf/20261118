import {
  DURATION_SECONDS,
  INPUT_FRAMES,
  INPUT_RATE,
  SIGNAL_SEGMENTS,
  TRANSIENT_TIME,
} from './config.js';

const TAU = Math.PI * 2;

function smoothstep(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function edgeGain(time, start, end, fadeSeconds) {
  const attack = smoothstep((time - start) / fadeSeconds);
  const release = smoothstep((end - time) / fadeSeconds);
  return Math.min(attack, release);
}

function transientAt(time) {
  const local = time - TRANSIENT_TIME;
  if (local < 0 || local >= 0.045) {
    return 0;
  }

  const attack = smoothstep(local / 0.00008);
  const decay = Math.exp(-local / 0.0045);
  const click = local < 0.0015 ? 0.38 * (1 - local / 0.0015) : 0;
  const body = decay * (
    0.68 * Math.sin(TAU * 3200 * local)
    + 0.26 * Math.sin(TAU * 9100 * local + 0.7)
  );
  return attack * body + click;
}

function sampleLeft(time) {
  if (time < 1.25) {
    const gain = edgeGain(time, 0, 1.25, 0.008);
    return gain * (
      0.58 * Math.sin(TAU * 997 * time)
      + 0.18 * Math.sin(TAU * 1331 * time + 0.3)
    );
  }

  if (time >= TRANSIENT_TIME && time < TRANSIENT_TIME + 0.045) {
    return transientAt(time);
  }

  if (time >= 2.55 && time < 3.95) {
    const gain = edgeGain(time, 2.55, 3.95, 0.02);
    const modulation = 0.86 + 0.14 * Math.sin(TAU * 3.5 * (time - 2.55));
    return gain * 0.34 * modulation * Math.sin(TAU * 7420 * time + 0.2);
  }

  if (time >= 4.35 && time < 5.35) {
    const gain = edgeGain(time, 4.35, 5.35, 0.018);
    return gain * 0.31 * Math.sin(TAU * 19500 * time);
  }

  if (time >= 5.35 && time < 5.7) {
    const gain = edgeGain(time, 5.35, 5.7, 0.008);
    const decay = 0.5 + 0.5 * Math.exp(-(time - 5.35) / 0.09);
    return gain * decay * 0.48 * Math.sin(TAU * 1000 * (time - 5.35));
  }

  return 0;
}

export function generateInputSignal() {
  const left = new Float64Array(INPUT_FRAMES);
  const right = new Float64Array(INPUT_FRAMES);

  for (let frame = 0; frame < INPUT_FRAMES; frame += 1) {
    const time = frame / INPUT_RATE;
    const leftSample = Math.max(-1, Math.min(1, sampleLeft(time)));
    left[frame] = leftSample;
    right[frame] = leftSample * (time >= TRANSIENT_TIME ? 0.82 : 0.76);
  }

  return {
    left,
    right,
    sampleRate: INPUT_RATE,
    frames: INPUT_FRAMES,
    duration: DURATION_SECONDS,
    segments: SIGNAL_SEGMENTS,
    transientTime: TRANSIENT_TIME,
  };
}

export function getSignalEnvelope(channel, buckets) {
  const envelope = new Float32Array(buckets);
  const bucketSize = channel.length / buckets;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * bucketSize);
    const end = Math.min(channel.length, Math.ceil((bucket + 1) * bucketSize));
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      const magnitude = Math.abs(channel[index]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    envelope[bucket] = peak;
  }

  return envelope;
}
