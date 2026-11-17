import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { before, test } from "node:test";
import { ensureFixtures } from "../tools/fixtures.js";

let fixtures;
const cli = path.resolve("bin/fmp4-merge.js");

before(async () => {
  fixtures = await ensureFixtures();
});

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

test("CLI writes a report and merged output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fmp4-cli-"));
  try {
    const output = path.join(directory, "merged.mp4");
    const result = runCli(["-o", output, fixtures.init, ...fixtures.segments]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /samples\s+keyframe starts/);
    assert.match(result.stdout, /Estimated merged duration: 6\.021 s/);
    assert.ok(existsSync(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI blocks missing and duplicate segments without writing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fmp4-cli-"));
  try {
    const missingOutput = path.join(directory, "missing.mp4");
    const missing = runCli([
      "-o", missingOutput, fixtures.init,
      ...fixtures.segments.filter((file) => !file.endsWith("seg-00002.m4s")),
    ]);
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /Missing source sequence numbers: 2/);
    assert.equal(existsSync(missingOutput), false);

    const duplicateOutput = path.join(directory, "duplicate.mp4");
    const duplicate = runCli([
      "-o", duplicateOutput, fixtures.init,
      ...fixtures.segments,
      fixtures.segments[3],
    ]);
    assert.equal(duplicate.status, 2);
    assert.match(duplicate.stderr, /duplicate source sequence #3/);
    assert.equal(existsSync(duplicateOutput), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
