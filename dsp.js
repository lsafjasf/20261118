// dsp.js — shared spectral-gate DSP core.
// Used by the AudioWorklet processor (noise-gate-worklet.js) and by the
// offline Node test harness (test/offline-test.mjs). Pure ES module, no
// browser or Node specific APIs.
const TWO_PI = Math.PI * 2;

export class FFT {
  constructor(size) {
    this.size = size;
    this.levels = Math.round(Math.log2(size));
    if ((1 << this.levels) !== size) {
      throw new Error('FFT size must be a power of two');
    }
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < this.levels; b++) {
        r |= ((i >> b) & 1) << (this.levels - 1 - b);
      }
      this.rev[i] = r;
    }
    const half = size / 2;
    this.cosTable = new Float32Array(half);
    this.sinTable = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTable[i] = Math.cos((-TWO_PI * i) / size);
      this.sinTable[i] = Math.sin((-TWO_PI * i) / size);
    }
  }

  transform(re, im, inverse) {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len *= 2) {
      const half = len / 2;
      const step = n / len;
      for (let base = 0; base < n; base += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cosTable[k];
          const s = inverse ? -this.sinTable[k] : this.sinTable[k];
          const a = base + j;
          const b = a + half;
          const tre = re[b] * c - im[b] * s;
          const tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre;
          im[b] = im[a] - tim;
          re[a] += tre;
          im[a] += tim;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }

  forward(re, im) {
    this.transform(re, im, false);
  }

  inverse(re, im) {
    this.transform(re, im, true);
  }
}

export const DEFAULT_PARAMS = {
  thresholdDb: 11,
  attackMs: 3,
  releaseMs: 150,
  lowKeep: 0.2,
};

const MIN_GAIN = 0.02;
const LOW_KEEP_HZ = 300;
const NUM_BANDS = 26;
const BAND_MIN_HZ = 40;

export class SpectralGate {
  constructor({ sampleRate = 48000, fftSize = 1024, hopSize = 256 } = {}) {
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.bins = fftSize / 2;
    this.fft = new FFT(fftSize);
    this.params = { ...DEFAULT_PARAMS };

    this.window = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / fftSize);
    }
    // COLA normalisation for analysis+synthesis Hann windows at this hop.
    let norm = 0;
    for (let i = 0; i < hopSize; i++) {
      let acc = 0;
      for (let k = i; k < fftSize; k += hopSize) {
        acc += this.window[k] * this.window[k];
      }
      norm = Math.max(norm, acc);
    }
    this.olaNorm = norm;

    // Log-spaced analysis bands from BAND_MIN_HZ to Nyquist.
    const nyquist = sampleRate / 2;
    this.bandEdges = new Float32Array(NUM_BANDS + 1);
    for (let b = 0; b <= NUM_BANDS; b++) {
      const t = b / NUM_BANDS;
      this.bandEdges[b] = BAND_MIN_HZ * Math.pow(nyquist / BAND_MIN_HZ, t);
    }
    this.bandCenter = new Float32Array(NUM_BANDS);
    for (let b = 0; b < NUM_BANDS; b++) {
      this.bandCenter[b] = Math.sqrt(this.bandEdges[b] * this.bandEdges[b + 1]);
    }
    this.binBand = new Int16Array(this.bins + 1);
    for (let k = 0; k <= this.bins; k++) {
      const freq = (k * sampleRate) / fftSize;
      let band = 0;
      if (freq >= BAND_MIN_HZ) {
        band = NUM_BANDS - 1;
        for (let b = 0; b < NUM_BANDS; b++) {
          if (freq < this.bandEdges[b + 1]) {
            band = b;
            break;
          }
        }
      }
      this.binBand[k] = band;
    }
    // Fractional band position per bin for smooth (log-domain) gain
    // interpolation between neighbouring band centres.
    this.binBandLo = new Int16Array(this.bins + 1);
    this.binBandFrac = new Float32Array(this.bins + 1);
    for (let k = 0; k <= this.bins; k++) {
      const freq = (k * sampleRate) / fftSize;
      let lo = 0;
      let frac = 0;
      if (freq >= this.bandCenter[NUM_BANDS - 1]) {
        lo = NUM_BANDS - 1;
      } else if (freq > this.bandCenter[0]) {
        for (let b = 0; b < NUM_BANDS - 1; b++) {
          if (freq < this.bandCenter[b + 1]) {
            lo = b;
            frac = Math.log(freq / this.bandCenter[b])
              / Math.log(this.bandCenter[b + 1] / this.bandCenter[b]);
            break;
          }
        }
      }
      this.binBandLo[k] = lo;
      this.binBandFrac[k] = frac;
    }

    this.floor = new Float32Array(NUM_BANDS).fill(1e-5);
    this.gain = new Float32Array(NUM_BANDS).fill(1);
    this.hold = new Float32Array(NUM_BANDS);
    this.bandMag = new Float32Array(NUM_BANDS);
    this.desired = new Float32Array(NUM_BANDS);
    this.prevBandMag = new Float32Array(NUM_BANDS).fill(1e-9);
    this.transientHold = 0;
    this.bandCount = new Uint16Array(NUM_BANDS);

    // Framing / OLA state.
    this.hist = new Float32Array(fftSize);
    this.histFill = 0;
    this.ola = new Float32Array(fftSize);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.binGain = new Float32Array(this.bins + 1);

    // Output FIFO pre-filled with one frame of silence: fixed latency of
    // exactly fftSize samples, independent of runtime.
    this.fifo = new Float32Array(fftSize * 8);
    this.fifoRead = 0;
    this.fifoWrite = fftSize;
    this.fifoLen = fftSize;
    this.latencySamples = fftSize;

    // Telemetry state.
    this.totalIn = 0;
    this.totalOut = 0;
    this.frames = 0;
    this.warmupFrames = 100;
    this.inPowAcc = 0;
    this.outPowAcc = 0;
    this.levelCount = 0;
    this.spectrumDb = new Float32Array(this.bins + 1).fill(-120);
    this.gainCurveDb = new Float32Array(this.bins + 1);
    this.attenDb = 0;

    this._updateCoeffs();
  }

  setParams(p) {
    Object.assign(this.params, p);
    this._updateCoeffs();
  }

  _updateCoeffs() {
    const frameSec = this.hopSize / this.sampleRate;
    const attackSec = Math.max(0.0005, this.params.attackMs / 1000);
    const releaseSec = Math.max(0.001, this.params.releaseMs / 1000);
    this.attackCoeff = 1 - Math.exp(-frameSec / attackSec);
    this.releaseCoeff = 1 - Math.exp(-frameSec / releaseSec);
    this.threshLin = Math.pow(10, this.params.thresholdDb / 20);
    // Minimum open time once a band is opened by a transient, so the
    // decaying tail of a short burst is not re-gated mid-burst.
    this.holdFrames = Math.round(0.08 / frameSec);
  }

  // Consume `input` and fill `output` (same length, any chunk size).
  // Output is the input delayed by exactly `latencySamples` and spectrally
  // gated. The delay is structural (FIFO pre-fill) and cannot drift.
  process(input, output) {
    const n = Math.min(input.length, output.length);
    for (let i = 0; i < n; i++) {
      const x = input[i];
      this.inPowAcc += x * x;
      this.hist[this.histFill++] = x;
      this.totalIn++;
      if (this.histFill === this.fftSize) {
        this._processFrame();
        this.hist.copyWithin(0, this.hopSize);
        this.histFill = this.fftSize - this.hopSize;
      }
      let y = 0;
      if (this.fifoLen > 0) {
        y = this.fifo[this.fifoRead];
        this.fifoRead = (this.fifoRead + 1) % this.fifo.length;
        this.fifoLen--;
      }
      this.outPowAcc += y * y;
      this.levelCount++;
      this.totalOut++;
      output[i] = y;
    }
  }

  _fifoPush(v) {
    if (this.fifoLen < this.fifo.length) {
      this.fifo[this.fifoWrite] = v;
      this.fifoWrite = (this.fifoWrite + 1) % this.fifo.length;
      this.fifoLen++;
    }
  }

  _processFrame() {
    const { fftSize, hopSize, bins, re, im, window } = this;
    for (let i = 0; i < fftSize; i++) {
      re[i] = this.hist[i] * window[i];
      im[i] = 0;
    }
    this.fft.forward(re, im);

    this.bandMag.fill(0);
    this.bandCount.fill(0);
    for (let k = 0; k <= bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const b = this.binBand[k];
      this.bandMag[b] += mag;
      this.bandCount[b]++;
      const db = 20 * Math.log10(mag + 1e-9);
      this.spectrumDb[k] = Math.max(db, this.spectrumDb[k] * 0.75 + db * 0.25);
    }

    // First pass: raw per-band desired gain from the noise-floor margin.
    // Also accumulate a floor-gated spectral flux: sudden level jumps in
    // bands that are clearly above the noise floor indicate a transient.
    let flux = 0;
    for (let b = 0; b < NUM_BANDS; b++) {
      const mag = this.bandCount[b] > 0 ? this.bandMag[b] / this.bandCount[b] : 0;
      // Noise-floor tracker: rises quickly towards the band magnitude and
      // falls slowly, so it hugs the upper envelope of fluctuating rumble.
      // Upward adaptation nearly freezes while the band is far above the
      // floor (speech bursts), so transients do not lift the estimate.
      const fl = this.floor[b];
      if (this.frames < this.warmupFrames) {
        this.floor[b] = fl * 0.9 + mag * 0.1;
      } else if (mag < fl) {
        this.floor[b] = fl * 0.998 + mag * 0.002;
      } else {
        const upCoeff = mag < fl * 2.5 ? 0.02 : 0.0002;
        this.floor[b] = fl * (1 - upCoeff) + mag * upCoeff;
      }
      const thresh = this.floor[b] * this.threshLin;
      let desired;
      if (mag >= thresh) {
        desired = 1;
      } else {
        // Smoothstep knee: fully closed below R_LO * thresh, fully open at
        // thresh. Keeps stationary-noise fluctuations firmly gated while
        // letting strong transients through without a hard edge.
        const R_LO = 0.55;
        const r = mag / (thresh + 1e-12);
        let t = (r - R_LO) / (1 - R_LO);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const s = t * t * (3 - 2 * t);
        desired = MIN_GAIN + (1 - MIN_GAIN) * s;
      }
      this.desired[b] = desired;
      if (this.frames >= this.warmupFrames && mag > this.floor[b] * 1.6) {
        flux += Math.max(0, Math.log(mag + 1e-9) - Math.log(this.prevBandMag[b]));
      }
      this.prevBandMag[b] = mag + 1e-9;
    }
    if (flux > 5.5) {
      this.transientHold = this.holdFrames;
    } else if (this.transientHold > 0) {
      this.transientHold--;
    }

    let attenAcc = 0;
    for (let b = 0; b < NUM_BANDS; b++) {
      const mag = this.bandCount[b] > 0 ? this.bandMag[b] / this.bandCount[b] : 0;
      // Neighbourhood linking: a strong transient opens the whole local
      // region, so burst energy spread across band edges is preserved.
      let desired = this.desired[b];
      if (b > 0) desired = Math.max(desired, this.desired[b - 1]);
      if (b < NUM_BANDS - 1) desired = Math.max(desired, this.desired[b + 1]);
      // During a detected transient, open every band that currently carries
      // signal above the noise floor so the burst passes through intact.
      if (this.transientHold > 0 && mag > this.floor[b] * 1.2) {
        desired = 1;
      }
      if (this.bandCenter[b] < LOW_KEEP_HZ) {
        desired = Math.max(desired, this.params.lowKeep);
      }
      if (desired >= 0.99) {
        this.hold[b] = this.holdFrames;
      } else if (this.hold[b] > 0) {
        this.hold[b]--;
        desired = Math.max(desired, 1);
      }
      const coeff = desired > this.gain[b] ? this.attackCoeff : this.releaseCoeff;
      this.gain[b] += (desired - this.gain[b]) * coeff;
      attenAcc += 20 * Math.log10(this.gain[b] + 1e-9);
    }
    this.attenDb = attenAcc / NUM_BANDS;

    for (let k = 0; k <= bins; k++) {
      const lo = this.binBandLo[k];
      const hi = Math.min(lo + 1, NUM_BANDS - 1);
      const frac = this.binBandFrac[k];
      const logG = (1 - frac) * Math.log(this.gain[lo] + 1e-9)
        + frac * Math.log(this.gain[hi] + 1e-9);
      const g = Math.exp(logG);
      this.binGain[k] = g;
      this.gainCurveDb[k] = 20 * Math.log10(g + 1e-9);
      re[k] *= g;
      im[k] *= g;
    }
    for (let k = 1; k < bins; k++) {
      re[fftSize - k] = re[k];
      im[fftSize - k] = -im[k];
    }

    this.fft.inverse(re, im);
    const norm = this.olaNorm;
    for (let i = 0; i < fftSize; i++) {
      this.ola[i] += (re[i] * window[i]) / norm;
    }
    for (let i = 0; i < hopSize; i++) {
      this._fifoPush(this.ola[i]);
    }
    this.ola.copyWithin(0, hopSize);
    this.ola.fill(0, fftSize - hopSize);
    this.frames++;
  }

  getTelemetry() {
    const count = Math.max(1, this.levelCount);
    const toDb = (p) => 10 * Math.log10(p / count + 1e-12);
    const t = {
      inDb: toDb(this.inPowAcc),
      outDb: toDb(this.outPowAcc),
      attenDb: this.attenDb,
      frames: this.frames,
      totalIn: this.totalIn,
      totalOut: this.totalOut,
      hopSize: this.hopSize,
      fifoLevel: this.fifoLen,
      latencySamples: this.latencySamples,
      latencyMs: (this.latencySamples / this.sampleRate) * 1000,
      spectrumDb: this.spectrumDb.slice(),
      gainCurveDb: this.gainCurveDb.slice(),
    };
    this.inPowAcc = 0;
    this.outPowAcc = 0;
    this.levelCount = 0;
    return t;
  }
}
