/** Iterative radix-2 Cooley-Tukey FFT over interleaved complex arrays. */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place FFT. re/im length must be a power of two. inverse=false -> forward. */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error("fft: length must be a power of two");
  }
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curWr = 1;
      let curWi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const vr = re[b] * curWr - im[b] * curWi;
        const vi = re[b] * curWi + im[b] * curWr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
        const nwr = curWr * wr - curWi * wi;
        curWi = curWr * wi + curWi * wr;
        curWr = nwr;
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

/** Forward FFT of a real signal, zero-padded to n (power of two). */
export function rfft(signal: ArrayLike<number>, n: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = Math.min(signal.length, n);
  for (let i = 0; i < len; i++) re[i] = signal[i];
  fft(re, im, false);
  return { re, im };
}

/** Inverse FFT, returns the real part. */
export function irfft(re: Float64Array, im: Float64Array): Float64Array {
  const r = Float64Array.from(re);
  const i = Float64Array.from(im);
  fft(r, i, true);
  return r;
}

/** Linear convolution via FFT. */
export function convolve(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const n = nextPow2(a.length + b.length - 1);
  const fa = rfft(a, n);
  const fb = rfft(b, n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = fa.re[i] * fb.re[i] - fa.im[i] * fb.im[i];
    im[i] = fa.re[i] * fb.im[i] + fa.im[i] * fb.re[i];
  }
  const out = irfft(re, im);
  return out.subarray(0, a.length + b.length - 1) as Float64Array;
}
