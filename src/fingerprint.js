// JS host for the WASM fingerprint core. Works in Node and the browser.
import { SAMPLE_RATE } from "./song.js";
import { resampleAt } from "./variants.js";

const HOP = 512;
const FRAME_SEC = HOP / SAMPLE_RATE;

// Hypothesis grids: tempo handled by resampling the query, pitch by
// shifting log-frequency bins inside the WASM query (2 bins = 1 semitone).
export const TEMPO_RATIOS = [0.94, 0.97, 1.0, 1.03, 1.06];
export const PITCH_BIN_SHIFTS = [-6, -3, 0, 3, 6];

export const CONFIDENCE_THRESHOLD = 0.1;

function abortImport() {
  return {
    env: {
      abort(msg, file, line, col) {
        throw new Error(`WASM abort at ${line}:${col}`);
      },
    },
  };
}

export async function createMatcher(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, abortImport());
  const ex = instance.exports;

  function upload(pcm) {
    const ptr = ex.pcmAlloc(pcm.length);
    new Float32Array(ex.memory.buffer, ptr, pcm.length).set(pcm);
  }

  function resetIndex() {
    ex.resetIndex();
  }

  function indexSong(songId, pcm) {
    upload(pcm);
    return ex.indexSong(songId);
  }

  // Query once per (tempo, pitch) hypothesis, merge candidates, return top 3.
  function queryTop3(pcm, tempoRatios = TEMPO_RATIOS, pitchShifts = PITCH_BIN_SHIFTS) {
    const merged = new Map(); // songId -> best candidate
    for (const ratio of tempoRatios) {
      const q = ratio === 1.0 ? pcm : resampleAt(pcm, ratio);
      upload(q);
      for (const shift of pitchShifts) {
        const n = ex.query(shift);
        const queryHashes = ex.getQueryHashes();
        for (let i = 0; i < n; i++) {
          const songId = ex.getResultSongId(i);
          const offsetFrames = ex.getResultOffset(i);
          const matches = ex.getResultMatches(i);
          const cand = {
            songId,
            offsetFrames,
            offsetSec: offsetFrames * FRAME_SEC,
            matches,
            queryHashes,
            confidence: queryHashes > 0 ? matches / queryHashes : 0,
            tempoRatio: ratio,
            pitchBins: shift,
          };
          const prev = merged.get(songId);
          if (!prev || cand.matches > prev.matches) merged.set(songId, cand);
        }
      }
    }
    return [...merged.values()].sort((a, b) => b.matches - a.matches).slice(0, 3);
  }

  return { resetIndex, indexSong, queryTop3, FRAME_SEC };
}

// Node-only convenience: load from a file path or file:// URL.
export async function createMatcherFromFile(path) {
  const { readFile } = await import("node:fs/promises");
  return createMatcher(await readFile(path));
}
