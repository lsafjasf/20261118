import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const STORE_PATH = path.resolve('media/store.json');

export async function saveStore(store) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store));
}

export async function loadStore() {
  const raw = JSON.parse(await readFile(STORE_PATH, 'utf8'));
  const decode = (chunks) =>
    chunks.map((c) => ({
      ts: c.ts,
      dur: c.dur,
      type: c.type,
      data: Buffer.from(c.data, 'base64'),
    }));
  const decodeDesc = (cfg) => {
    if (cfg && cfg.description) {
      return { ...cfg, description: Buffer.from(cfg.description, 'base64') };
    }
    return cfg;
  };
  return {
    video: {
      config: decodeDesc(raw.video.config),
      chunks: decode(raw.video.chunks),
    },
    audio: {
      config: decodeDesc(raw.audio.config),
      chunks: decode(raw.audio.chunks),
    },
  };
}

// Seeded PRNG (mulberry32) so impairment patterns are reproducible in tests.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
