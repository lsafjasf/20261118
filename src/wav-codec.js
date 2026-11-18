/* 16-bit PCM WAV encoder/decoder (no browser speech APIs involved). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.WavCodec = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function encode(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function decode(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const isWav = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) === "RIFF";
    if (!isWav) throw new Error("Only PCM WAV decoding is implemented offline");
    let off = 12;
    let dataOff = 44;
    let dataLen = view.byteLength - 44;
    let sampleRate = 16000;
    let bits = 16;
    while (off + 8 <= view.byteLength) {
      const id = String.fromCharCode(
        view.getUint8(off), view.getUint8(off + 1),
        view.getUint8(off + 2), view.getUint8(off + 3));
      const size = view.getUint32(off + 4, true);
      if (id === "fmt ") {
        sampleRate = view.getUint32(off + 12, true);
        bits = view.getUint16(off + 22, true);
      } else if (id === "data") {
        dataOff = off + 8;
        dataLen = size;
        break;
      }
      off += 8 + size;
    }
    const frameBytes = bits / 8;
    const count = Math.floor(dataLen / frameBytes);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      samples[i] = view.getInt16(dataOff + i * frameBytes, true) / 0x8000;
    }
    return { samples, sampleRate };
  }

  // Linear + simple anti-alias averaging resample to 16 kHz mono.
  function resampleTo16k(samples, inRate) {
    if (inRate === 16000) return samples;
    const ratio = inRate / 16000;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const a = samples[i0] || 0;
      const b = samples[i0 + 1] || a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  return { encode, decode, resampleTo16k };
});
