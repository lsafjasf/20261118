// JavaScript wrapper around the hand-written WebAssembly declicker module.
// Responsibilities kept on the JS side: memory allocation inside the WASM
// linear memory, (de)interleaving file data, decoding/encoding WAV files and
// waveform rendering. The WASM side only sees pointers and lengths.
'use strict';

const SCRATCH_BYTES = 4120 + 480000 * 4; // flags for up to 10 s @ 48 kHz

class Declicker {
  constructor(instance) {
    this.exports = instance.exports;
    this.memory = instance.exports.memory;
    this.ptr = 0;
  }

  static async create(wasmPath) {
    const isBrowser = typeof window !== 'undefined' && typeof fetch === 'function';
    const bytes = await (isBrowser
      ? fetch(wasmPath).then((r) => {
          if (!r.ok) throw new Error(`fetch ${wasmPath}: ${r.status}`);
          return r.arrayBuffer();
        })
      : require('node:fs/promises').readFile(wasmPath));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new Declicker(instance);
  }

  // Allocate input + scratch regions, copy PCM in, run repair, copy out.
  // Returns { output: Float32Array, regions: Array<[start, end)>, modified, ns }
  process(input, mode = 0) {
    const n = input.length;
    const inputBytes = n * 4;
    const total = inputBytes + SCRATCH_BYTES;
    if (this._capacity === undefined || this._capacity < total) {
      const requiredPages = Math.ceil(total / 65536);
      const currentPages = this.memory.buffer.byteLength / 65536;
      if (requiredPages > currentPages) {
        this.memory.grow(requiredPages - currentPages + 1);
      }
      this._capacity = this.memory.buffer.byteLength;
    }
    const pcmPtr = this.ptr;
    const scratchPtr = pcmPtr + inputBytes;
    const f32 = new Float32Array(this.memory.buffer, pcmPtr, n);
    f32.set(input);

    const t0 =
      typeof performance !== 'undefined' ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1e6;
    const modified = this.exports.declick(pcmPtr, n, scratchPtr, mode | 0);
    const t1 =
      typeof performance !== 'undefined' ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1e6;

    const count = this.exports.region_count(scratchPtr);
    const regions = [];
    for (let k = 0; k < count; k++) {
      regions.push([
        this.exports.region_start(scratchPtr, k),
        this.exports.region_end(scratchPtr, k),
      ]);
    }
    const output = new Float32Array(
      new Float32Array(this.memory.buffer, pcmPtr, n)
    );
    return { output, regions, modified, ns: Math.round((t1 - t0) * 1e6) };
  }

  version() {
    return this.exports.module_version();
  }
}

module.exports = { Declicker, SCRATCH_BYTES };
