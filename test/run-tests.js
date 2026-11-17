// End-to-end test: index 3 synthetic songs, query with degraded variants
// of song #1 plus an unrelated song, verify ranking and thresholding.
import { generateSong } from "../src/song.js";
import { clip, addNoise, resampleAt, pitchShift } from "../src/variants.js";
import { createMatcherFromFile, CONFIDENCE_THRESHOLD } from "../src/fingerprint.js";

const SONG_IDS = [1, 2, 3];
const TARGET = 1;

function fmt(c) {
  if (!c) return "(none)";
  return `song=${c.songId} offset=${c.offsetSec.toFixed(2)}s ` +
    `matches=${c.matches}/${c.queryHashes} conf=${c.confidence.toFixed(3)} ` +
    `tempo=${c.tempoRatio} pitchBins=${c.pitchBins}`;
}

async function main() {
  const matcher = await createMatcherFromFile(new URL("../build/fingerprint.wasm", import.meta.url));

  const songs = new Map();
  matcher.resetIndex();
  for (const id of SONG_IDS) {
    const pcm = generateSong(id * 1000 + 7, 40);
    songs.set(id, pcm);
    const hashes = matcher.indexSong(id, pcm);
    console.log(`indexed song ${id}: ${hashes} hashes`);
  }

  const target = songs.get(TARGET);
  const unrelated = generateSong(424242, 40);

  const cases = [
    ["clean clip (t=10s, 12s)", clip(target, 10, 12), true, 10],
    ["noisy clip (SNR 5dB)", addNoise(clip(target, 10, 12), 5), true, 10],
    ["sped-up clip (1.06x)", resampleAt(clip(target, 10, 15), 1.06), true, 10],
    ["pitch-shifted clip (+2 st)", pitchShift(clip(target, 10, 12), 2), true, 10],
    ["unrelated song clip", clip(unrelated, 10, 12), false, null],
  ];

  let failures = 0;
  for (const [name, pcm, shouldMatch, expectOffset] of cases) {
    const top3 = matcher.queryTop3(pcm);
    console.log(`\ncase: ${name}`);
    top3.forEach((c, i) => console.log(`  #${i + 1} ${fmt(c)}`));
    const best = top3[0];
    if (shouldMatch) {
      if (!best || best.songId !== TARGET) {
        console.log(`  FAIL: expected song ${TARGET} at rank 1`);
        failures++;
      } else if (best.confidence < CONFIDENCE_THRESHOLD) {
        console.log(`  FAIL: confidence ${best.confidence.toFixed(3)} below ${CONFIDENCE_THRESHOLD}`);
        failures++;
      } else if (Math.abs(best.offsetSec - expectOffset) > 0.6) {
        console.log(`  FAIL: offset ${best.offsetSec.toFixed(2)}s, expected ~${expectOffset}s`);
        failures++;
      } else {
        console.log("  PASS");
      }
    } else {
      if (best && best.confidence >= CONFIDENCE_THRESHOLD) {
        console.log(`  FAIL: unrelated audio confidence ${best.confidence.toFixed(3)} >= ${CONFIDENCE_THRESHOLD}`);
        failures++;
      } else {
        console.log("  PASS (below threshold)");
      }
    }
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
