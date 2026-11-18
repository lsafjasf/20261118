/* Minimal radix-2 in-place FFT, UMD-style so it works in browser and Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FFT = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function FFT(size) {
    if ((size & (size - 1)) !== 0 || size < 2) {
      throw new Error("FFT size must be a power of 2 >= 2");
    }
    this.size = size;
    this.rev = new Uint32Array(size);
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
    for (let k = 0; k < size / 2; k++) {
      const a = (-2 * Math.PI * k) / size;
      this.cos[k] = Math.cos(a);
      this.sin[k] = Math.sin(a);
    }
  }

  // re/im are Float32Array of length size; transformed in place.
  FFT.prototype.run = function (re, im) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let start = 0; start < n; start += len) {
        let k = 0;
        for (let j = 0; j < half; j++, k += step) {
          const wr = this.cos[k];
          const wi = this.sin[k];
          const a = start + j;
          const b = a + half;
          const vr = re[b];
          const vi = im[b];
          re[b] = re[a] - wr * vr + wi * vi;
          im[b] = im[a] - wr * vi - wi * vr;
          re[a] += wr * vr - wi * vi;
          im[a] += wr * vi + wi * vr;
        }
      }
    }
    return { re, im };
  };

  return FFT;
});
