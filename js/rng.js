/* 可复现随机数: mulberry32 + Box-Muller 高斯 */
(function (global) {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seed) {
    const next = mulberry32(seed);
    return {
      uniform: () => next(),
      range: (lo, hi) => lo + (hi - lo) * next(),
      gauss(mean, std) {
        let u = 0, v = 0;
        while (u === 0) u = next();
        while (v === 0) v = next();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return mean + z * std;
      },
      chance: (p) => next() < p,
    };
  }

  const api = { makeRng };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.RngUtil = api;
})(typeof window !== "undefined" ? window : globalThis);
