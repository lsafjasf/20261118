import assert from "node:assert/strict";
import { before, test } from "node:test";
import { inspectMp4 } from "../src/mp4.js";
import { parseMoof } from "../src/fragment.js";
import {
  MergeError,
  mergeInputs,
  readInputs,
  verifyMerged,
} from "../src/merge.js";
import { ensureFixtures } from "../tools/fixtures.js";

let fixtures;

before(async () => {
  fixtures = await ensureFixtures();
});

function allFiles() {
  return [fixtures.init, ...fixtures.segments];
}

test("merges all fragments with continuous per-track decode times", async () => {
  const inputs = await readInputs(allFiles());
  assert.equal(inputs.sequenceSource, "filename");
  assert.deepEqual(inputs.missing, []);

  const result = mergeInputs(inputs);
  const verification = verifyMerged(result.buffer);
  assert.equal(verification.fragmentCount, 6);
  assert.deepEqual(
    result.segments.map((segment) => segment.sourceIndex),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    result.segments.map((segment) => Math.round(segment.keyframeTimes[0])),
    [0, 1, 2, 3, 4, 5],
  );
  assert.ok(result.segments.every((segment) => segment.sampleCount > 0));

  const video = result.tracks.find((track) => track.handler === "vide");
  const audio = result.tracks.find((track) => track.handler === "soun");
  assert.ok(Math.abs(video.durationSeconds - 6) < 0.001);
  assert.ok(Math.abs(audio.durationSeconds - 6.0213) < 0.01);

  const output = inspectMp4(result.buffer);
  assert.equal(output.moofBoxes.length, 6);
  assert.equal(output.boxes.filter((box) => box.type === "moov").length, 1);
  const expected = new Map();
  for (let index = 0; index < output.moofBoxes.length; index += 1) {
    const fragment = parseMoof(output.buffer, output.moofBoxes[index], output.init);
    assert.equal(fragment.sequenceNumber, index + 1);
    for (const [trackId, track] of fragment.tracks) {
      assert.equal(track.baseDecodeTime, expected.get(trackId) ?? 0n);
      expected.set(trackId, track.baseDecodeTime + track.durationTicks);
    }
  }
});

test("sorts out-of-order inputs by their source filenames", async () => {
  const ordered = await readInputs(allFiles());
  const shuffled = await readInputs([
    fixtures.init,
    fixtures.segments[4],
    fixtures.segments[1],
    fixtures.segments[5],
    fixtures.segments[0],
    fixtures.segments[3],
    fixtures.segments[2],
  ]);
  assert.deepEqual(
    mergeInputs(shuffled).buffer,
    mergeInputs(ordered).buffer,
  );
});

test("blocks duplicate source indices and duplicate content", async () => {
  const inputs = await readInputs([
    fixtures.init,
    ...fixtures.segments.slice(0, 4),
    fixtures.segments[3],
    ...fixtures.segments.slice(4),
  ]);
  assert.throws(
    () => mergeInputs(inputs),
    (error) =>
      error instanceof MergeError &&
      error.code === "DUPLICATE_SEGMENTS" &&
      error.details.duplicateIndices[0].sourceIndex === 3,
  );
});

test("lists missing source numbers and writes no timeline unless allowed", async () => {
  const lossyFiles = allFiles().filter((file) => !file.endsWith("seg-00002.m4s"));
  const inputs = await readInputs(lossyFiles);
  assert.deepEqual(inputs.missing, [2]);
  assert.throws(
    () => mergeInputs(inputs),
    (error) =>
      error instanceof MergeError &&
      error.code === "MISSING_SEGMENTS" &&
      error.message.includes("2"),
  );

  const compressed = mergeInputs(inputs, { allowGaps: true });
  assert.equal(verifyMerged(compressed.buffer).fragmentCount, 5);
  assert.deepEqual(
    compressed.segments.map((segment) => segment.sourceIndex),
    [0, 1, 3, 4, 5],
  );
});
