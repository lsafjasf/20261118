// End-to-end demo of the three required fixture groups:
//   1. manually reversed arrival order
//   2. duplicate chunks mixed into the stream
//   3. missing tail chunk
// Run: node test/demo.js
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stitchWebmChunks } from "../src/webm-stitcher.js";
import { parseChunk } from "../src/parse-chunk.js";
import { buildChunks } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const artifacts = path.join(root, "artifacts", "demo");
mkdirSync(artifacts, { recursive: true });

const chunks = buildChunks(path.join(root, "artifacts", "source.webm"));
const asEntries = (indexes) =>
  indexes.map((index) => ({
    id: `chunk-${index + 1}`,
    sequence: index + 1,
    data: chunks[index],
  }));

const groups = {
  "reversed": chunks.map((_, index) => chunks.length - 1 - index),
  "duplicates": [0, 1, 1, 2, 2, 3, 4],
  "missing-tail": [0, 1, 2, 3, 4],
};

for (const [name, indexes] of Object.entries(groups)) {
  const result = await stitchWebmChunks(asEntries(indexes));
  const base = path.join(artifacts, name);
  writeFileSync(`${base}.webm`, result.bytes);
  writeFileSync(`${base}.playlist.json`, `${JSON.stringify(result.playlist, null, 2)}\n`);
  const expected = result.playlist.sumOfEffectiveDurationsMs;
  console.log(
    `${name}: accepted=${result.playlist.acceptedChunkCount} ` +
      `rejected=${result.playlist.rejectedChunkCount} ` +
      `duration=${result.playlist.durationSeconds}s ` +
      `sumOfChunkDurations=${expected}ms match=${result.playlist.totalDurationMs === expected}`,
  );
}

console.log(
  `per-chunk effective durations: ${chunks.map((c) => parseChunk(c).durationMs).join(", ")} ms`,
);
