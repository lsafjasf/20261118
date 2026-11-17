import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { stitchWebmChunks } from "../src/webm-stitcher.js";
import { parseChunk } from "../src/parse-chunk.js";
import { ID, parseElements } from "../src/ebml.js";
import { buildChunks, buildBareClusterChunks } from "./fixtures.js";

const require = createRequire(import.meta.url);
const ffmpeg = require("ffmpeg-static");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const artifacts = path.join(root, "artifacts");
const sourcePath = path.join(artifacts, "source.webm");

test.before(() => {
  mkdirSync(artifacts, { recursive: true });
  if (!existsSync(sourcePath)) {
    execFileSync(ffmpeg, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
      "-t", "6", "-c:v", "libvpx", "-g", "10",
      "-deadline", "realtime", "-cpu-used", "4",
      "-cluster_time_limit", "1000", sourcePath,
    ]);
  }
});

function probeDuration(webmPath) {
  // ffmpeg exits non-zero when no output file is given, so use spawnSync and
  // read the banner from stderr.
  const proc = spawnSync(
    ffmpeg,
    ["-hide_banner", "-i", webmPath],
    { encoding: "utf8" },
  );
  const output = proc.stderr;
  const match = output.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  assert.ok(match, `ffmpeg did not report a duration:\n${output}`);
  return (
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  );
}

function assertDecodesClean(webmPath) {
  // Full decode; ffmpeg exits non-zero and prints errors on corrupt WebM.
  const proc = spawnSync(ffmpeg, [
    "-v", "error", "-i", webmPath, "-f", "null", "-",
  ], { encoding: "utf8" });
  assert.equal(
    proc.status,
    0,
    `ffmpeg decode failed:\n${proc.stderr}`,
  );
  assert.equal(proc.stderr.trim(), "", `decode warnings:\n${proc.stderr}`);
}

function outputTimecodes(bytes) {
  const parsed = parseChunk(bytes);
  return parsed.clusters.map((cluster) => cluster.timecode);
}

function entriesFrom(chunks, order) {
  return order.map((index) => ({
    id: `chunk-${index + 1}`,
    sequence: index + 1,
    blob: new Blob([chunks[index]], { type: "video/webm" }),
  }));
}

test("reverse-order chunks are stitched back in sequence order", async () => {
  const chunks = buildChunks(sourcePath);
  assert.ok(chunks.length >= 5, "fixture should contain several clusters");
  const reversedOrder = chunks.map((_, index) => index).reverse();

  const result = await stitchWebmChunks(entriesFrom(chunks, reversedOrder));
  const outPath = path.join(artifacts, "out-reversed.webm");
  writeFileSync(outPath, Buffer.from(await result.blob.arrayBuffer()));
  writeFileSync(
    path.join(artifacts, "playlist-reversed.json"),
    JSON.stringify(result.playlist, null, 2),
  );

  const expectedMs = result.playlist.sumOfEffectiveDurationsMs;
  assert.equal(result.playlist.totalDurationMs, expectedMs);
  assert.equal(
    result.playlist.chunks.map((chunk) => chunk.sequence).join(","),
    chunks.map((_, index) => index + 1).join(","),
    "playlist must follow sequence order, not arrival order",
  );

  const timecodes = outputTimecodes(result.bytes);
  assert.deepEqual(timecodes, [...timecodes].sort((a, b) => a - b));
  for (let i = 1; i < timecodes.length; i += 1) {
    assert.ok(timecodes[i] > timecodes[i - 1], "timecodes must advance");
  }

  const probed = probeDuration(outPath);
  assert.ok(
    Math.abs(probed - expectedMs / 1000) < 0.25,
    `probed ${probed}s vs expected ${expectedMs / 1000}s`,
  );
  assertDecodesClean(outPath);
});

test("duplicate chunks are rejected instead of counted twice", async () => {
  const chunks = buildChunks(sourcePath);
  const order = [0, 1, 1, 2, 2, 3, 4];
  const result = await stitchWebmChunks(entriesFrom(chunks, order));
  const outPath = path.join(artifacts, "out-duplicates.webm");
  writeFileSync(outPath, result.bytes);
  writeFileSync(
    path.join(artifacts, "playlist-duplicates.json"),
    JSON.stringify(result.playlist, null, 2),
  );

  assert.equal(result.playlist.acceptedChunkCount, 5);
  assert.equal(result.playlist.rejectedChunkCount, 2);
  assert.deepEqual(
    result.playlist.rejected.map((item) => item.reason),
    ["duplicate", "duplicate"],
  );
  assert.equal(result.playlist.rejected[0].duplicateOf, "chunk-2");

  const uniqueDurations = [0, 1, 2, 3, 4].reduce(
    (sum, index) => sum + parseChunk(chunks[index]).durationMs,
    0,
  );
  assert.equal(result.playlist.totalDurationMs, uniqueDurations);

  const probed = probeDuration(outPath);
  assert.ok(
    Math.abs(probed - uniqueDurations / 1000) < 0.25,
    `probed ${probed}s vs expected ${uniqueDurations / 1000}s`,
  );
  assertDecodesClean(outPath);
});

test("missing tail chunk leaves duration equal to the surviving chunks", async () => {
  const chunks = buildChunks(sourcePath);
  const full = await stitchWebmChunks(
    chunks.map((data, index) => ({
      id: `chunk-${index + 1}`,
      sequence: index + 1,
      data: data,
    })),
  );
  const surviving = chunks.slice(0, -1);
  const result = await stitchWebmChunks(
    surviving.map((data, index) => ({
      id: `chunk-${index + 1}`,
      sequence: index + 1,
      data: data,
    })),
  );
  const outPath = path.join(artifacts, "out-missing-tail.webm");
  writeFileSync(outPath, result.bytes);
  writeFileSync(
    path.join(artifacts, "playlist-missing-tail.json"),
    JSON.stringify(result.playlist, null, 2),
  );

  const expectedMs = surviving.reduce(
    (sum, chunk) => sum + parseChunk(chunk).durationMs,
    0,
  );
  assert.equal(result.playlist.totalDurationMs, expectedMs);
  assert.ok(result.playlist.totalDurationMs < full.playlist.totalDurationMs);
  assert.equal(
    result.playlist.chunks.length,
    surviving.length,
  );

  const probed = probeDuration(outPath);
  assert.ok(
    Math.abs(probed - expectedMs / 1000) < 0.25,
    `probed ${probed}s vs expected ${expectedMs / 1000}s`,
  );
  assertDecodesClean(outPath);
});

test("discontinuous restart timecodes are normalized into one timeline", async () => {
  const chunks = buildChunks(sourcePath, {
    // Resume after a pause: chunk 2's clock jumps backwards, chunk 4 forwards.
    shifts: [0, -2000, 0, 5000, 0, 0],
  });
  const originals = chunks.map((chunk) => parseChunk(chunk).firstTimecode);
  // The backwards jump is clamped to the unsigned minimum 0, which is still
  // behind the 1000ms slot the timeline would have assigned it.
  assert.ok(
    originals[1] < 1000 && originals[3] > originals[2],
    "fixture must contain both a clock reset and a forward jump",
  );

  const result = await stitchWebmChunks(
    chunks.map((data, index) => ({
      id: `chunk-${index + 1}`,
      sequence: index + 1,
      data: data,
    })),
  );
  const outPath = path.join(artifacts, "out-restart.webm");
  writeFileSync(outPath, result.bytes);

  const timecodes = outputTimecodes(result.bytes);
  assert.deepEqual(timecodes, [...timecodes].sort((a, b) => a - b));
  const expectedMs = result.playlist.sumOfEffectiveDurationsMs;
  const probed = probeDuration(outPath);
  assert.ok(
    Math.abs(probed - expectedMs / 1000) < 0.25,
    `probed ${probed}s vs expected ${expectedMs / 1000}s`,
  );
  assertDecodesClean(outPath);
});

test("bare Cluster chunks without EBML headers are supported", async () => {
  const chunks = buildBareClusterChunks(sourcePath);
  const result = await stitchWebmChunks([
    { id: "full", sequence: 1, data: buildChunks(sourcePath)[0] },
    ...chunks.slice(1).map((data, index) => ({
      id: `bare-${index + 2}`,
      sequence: index + 2,
      data,
    })),
  ]);
  const outPath = path.join(artifacts, "out-bare.webm");
  writeFileSync(outPath, result.bytes);
  assertDecodesClean(outPath);
  const parsed = parseChunk(result.bytes);
  const topLevel = parseElements(parsed.buf, 0, parsed.buf.length);
  assert.ok(topLevel.some((el) => el.id === ID.SEGMENT));
});

test("a truncated final cluster (abrupt interruption) is still usable", async () => {
  const chunks = buildChunks(sourcePath);
  // Simulate a crash mid-write: cut the last chunk's bytes in half. The
  // surviving Cluster header and preceding blocks must still parse.
  const last = chunks[chunks.length - 1];
  const truncated = Buffer.concat([
    last.subarray(0, Math.floor(last.length / 2)),
  ]);
  const entries = chunks.slice(0, -1).map((data, index) => ({
    id: `chunk-${index + 1}`,
    sequence: index + 1,
    data,
  }));
  entries.push({
    id: "chunk-6-truncated",
    sequence: 6,
    data: truncated,
  });

  const result = await stitchWebmChunks(entries);
  const outPath = path.join(artifacts, "out-truncated.webm");
  writeFileSync(outPath, result.bytes);
  assertDecodesClean(outPath);

  const healthySum = chunks.slice(0, -1).reduce(
    (sum, chunk) => sum + parseChunk(chunk).durationMs,
    0,
  );
  const probed = probeDuration(outPath);
  assert.ok(probed >= healthySum / 1000 - 0.25);
  assert.equal(
    result.playlist.totalDurationMs,
    result.playlist.sumOfEffectiveDurationsMs,
  );
});
