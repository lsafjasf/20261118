import {
  INPUT_RATE,
  KAISER_BETA,
  OUTPUT_RATE,
  REGIONS,
  TRANSIENT_TIME,
} from './config.js';

class Radix2Fft {
  constructor(size) {
    if ((size & (size - 1)) !== 0) {
      throw new Error('FFT size must be a power of two');
    }
    this.size = size;
    this.reverse = new Uint32Array(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);

    let bits = 0;
    while ((1 << bits) < size) {
      bits += 1;
    }

    for (let index = 0; index < size; index += 1) {
      let value = index;
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        reversed = (reversed << 1) | (value & 1);
        value >>= 1;
      }
      this.reverse[index] = reversed;
    }

    for (let index = 0; index < size / 2; index += 1) {
      const angle = -2 * Math.PI * index / size;
      this.cos[index] = Math.cos(angle);
      this.sin[index] = Math.sin(angle);
    }
  }

  transform(real, imag) {
    const { size, reverse, cos, sin } = this;

    for (let index = 0; index < size; index += 1) {
      const target = reverse[index];
      if (target > index) {
        let temporary = real[index];
        real[index] = real[target];
        real[target] = temporary;
        temporary = imag[index];
        imag[index] = imag[target];
        imag[target] = temporary;
      }
    }

    for (let length = 2; length <= size; length <<= 1) {
      const half = length / 2;
      const stride = size / length;
      for (let start = 0; start < size; start += length) {
        for (let offset = 0; offset < half; offset += 1) {
          const twiddle = offset * stride;
          const even = start + offset;
          const odd = even + half;
          const oddReal = real[odd] * cos[twiddle] - imag[odd] * sin[twiddle];
          const oddImag = real[odd] * sin[twiddle] + imag[odd] * cos[twiddle];
          real[odd] = real[even] - oddReal;
          imag[odd] = imag[even] - oddImag;
          real[even] += oddReal;
          imag[even] += oddImag;
        }
      }
    }
  }
}

let cachedFft = null;
let cachedHann = null;
let cachedFftSize = 0;

function hannWindow(size) {
  if (cachedHann && cachedFftSize === size) {
    return cachedHann;
  }
  cachedHann = new Float64Array(size);
  for (let index = 0; index < size; index += 1) {
    cachedHann[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / size);
  }
  cachedFftSize = size;
  return cachedHann;
}

export function computeWelchSpectrum(channel, sampleRate, options = {}) {
  const fftSize = options.fftSize ?? 16384;
  const requestedAverages = options.averages ?? 32;
  const maxFrequency = options.maxFrequency ?? 24000;
  const hop = fftSize / 2;
  const available = Math.max(1, Math.floor((channel.length - fftSize) / hop) + 1);
  const averages = Math.min(requestedAverages, available);
  const window = hannWindow(fftSize);
  const fft = cachedFft?.size === fftSize ? cachedFft : new Radix2Fft(fftSize);
  cachedFft = fft;
  const power = new Float64Array(fftSize / 2 + 1);
  let windowSum = 0;

  for (let index = 0; index < fftSize; index += 1) {
    windowSum += window[index];
  }

  for (let average = 0; average < averages; average += 1) {
    const offset = average * hop;
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    for (let index = 0; index < fftSize; index += 1) {
      real[index] = channel[offset + index] * window[index];
    }
    fft.transform(real, imag);
    for (let bin = 0; bin <= fftSize / 2; bin += 1) {
      power[bin] += real[bin] * real[bin] + imag[bin] * imag[bin];
    }
  }

  const maxBin = Math.min(fftSize / 2, Math.floor(maxFrequency * fftSize / sampleRate));
  const frequency = new Float32Array(maxBin + 1);
  const decibels = new Float32Array(maxBin + 1);
  const scale = 2 / (windowSum * averages);

  for (let bin = 0; bin <= maxBin; bin += 1) {
    const amplitude = Math.sqrt(power[bin]) * scale;
    frequency[bin] = bin * sampleRate / fftSize;
    decibels[bin] = 20 * Math.log10(Math.max(amplitude, 1e-9));
  }

  return { frequency, decibels, fftSize, averages };
}

function regionBounds(region, sampleRate, length) {
  return {
    start: Math.max(0, Math.floor(region.start * sampleRate)),
    end: Math.min(length, Math.ceil(region.end * sampleRate)),
  };
}

function regionError(current, reference, region, sampleRate) {
  const { start, end } = regionBounds(region, sampleRate, current.length);
  let peak = 0;
  let power = 0;
  let count = 0;

  for (let index = start; index < end; index += 1) {
    const difference = current[index] - reference[index];
    const magnitude = Math.abs(difference);
    if (magnitude > peak) {
      peak = magnitude;
    }
    power += difference * difference;
    count += 1;
  }

  return {
    peak,
    rms: count > 0 ? Math.sqrt(power / count) : 0,
    start,
    end,
  };
}

export function compareWithReference(output, reference) {
  const regions = REGIONS.map((region) => {
    const left = regionError(output.left, reference.left, region, OUTPUT_RATE);
    const right = regionError(output.right, reference.right, region, OUTPUT_RATE);
    const peak = Math.max(left.peak, right.peak);
    return {
      ...region,
      peak,
      peakLeft: left.peak,
      peakRight: right.peak,
      rmsLeft: left.rms,
      rmsRight: right.rms,
      rms: Math.sqrt((left.rms * left.rms + right.rms * right.rms) / 2),
      startSample: left.start,
      endSample: left.end,
    };
  });

  const fullLeft = regionError(
    output.left,
    reference.left,
    { start: 0, end: output.left.length / OUTPUT_RATE },
    OUTPUT_RATE,
  );
  const fullRight = regionError(
    output.right,
    reference.right,
    { start: 0, end: output.right.length / OUTPUT_RATE },
    OUTPUT_RATE,
  );

  return {
    regions,
    overall: {
      peak: Math.max(fullLeft.peak, fullRight.peak),
      peakLeft: fullLeft.peak,
      peakRight: fullRight.peak,
      rmsLeft: fullLeft.rms,
      rmsRight: fullRight.rms,
      rms: Math.sqrt((fullLeft.rms * fullLeft.rms + fullRight.rms * fullRight.rms) / 2),
    },
  };
}

export function buildTransientResidual(output, reference, buckets = 360) {
  const start = Math.floor((TRANSIENT_TIME - 0.04) * OUTPUT_RATE);
  const end = Math.ceil((TRANSIENT_TIME + 0.04) * OUTPUT_RATE);
  const bucketSize = (end - start) / buckets;
  const residual = new Float32Array(buckets);
  let peak = 0;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const first = start + Math.floor(bucket * bucketSize);
    const last = Math.min(end, start + Math.ceil((bucket + 1) * bucketSize));
    let localPeak = 0;
    for (let index = first; index < last; index += 1) {
      const left = output.left[index] - reference.left[index];
      const right = output.right[index] - reference.right[index];
      const magnitude = Math.max(Math.abs(left), Math.abs(right));
      if (magnitude > localPeak) {
        localPeak = magnitude;
      }
    }
    residual[bucket] = 20 * Math.log10(Math.max(localPeak, 1e-8));
    if (localPeak > peak) {
      peak = localPeak;
    }
  }

  return {
    residual,
    peak,
    startTime: (start - TRANSIENT_TIME * OUTPUT_RATE) / OUTPUT_RATE,
    endTime: (end - TRANSIENT_TIME * OUTPUT_RATE) / OUTPUT_RATE,
  };
}

export function buildGroupDelayCurve(tapsPerPhase, points = 180) {
  const frequency = new Float32Array(points);
  const delay = new Float32Array(points);
  const delayMs = (tapsPerPhase / 2) / INPUT_RATE * 1000;

  for (let index = 0; index < points; index += 1) {
    frequency[index] = index / (points - 1) * 22050;
    delay[index] = delayMs;
  }

  return {
    frequency,
    delay,
    delayMs,
    beta: KAISER_BETA,
    cutoff: 22050,
  };
}
