"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const TC = require("../timecode.js");

const DF_2997 = { rate: 29.97, dropFrame: true };
const NDF_2997 = { rate: 29.97, dropFrame: false };

test("29.97 drop-frame rejects labels that do not exist", () => {
  assert.throws(() => TC.timecodeToFrames("00:01:00;00", DF_2997), /不存在/);
  assert.throws(() => TC.timecodeToFrames("00:01:00;01", DF_2997), /不存在/);
  assert.equal(TC.timecodeToFrames("00:01:00;02", DF_2997), 1800);
  assert.equal(TC.timecodeToFrames("00:10:00;00", DF_2997), 17982);
});

test("drop-frame crosses the top of the hour without skipping labels", () => {
  assert.equal(TC.timecodeToFrames("00:59:59;29", DF_2997), 107891);
  assert.equal(TC.timecodeToFrames("01:00:00;00", DF_2997), 107892);
  assert.equal(TC.framesToTimecode(107891, DF_2997), "00:59:59;29");
  assert.equal(TC.framesToTimecode(107892, DF_2997), "01:00:00;00");
  assert.equal(
    TC.timecodeToFrames("01:00:00;00", DF_2997) -
      TC.timecodeToFrames("00:59:59;29", DF_2997),
    1
  );
});

test("drop-frame seconds use the exact 30000/1001 frame rate", () => {
  const frames = TC.timecodeToFrames("01:00:00;00", DF_2997);
  const seconds = TC.timecodeToSeconds("01:00:00;00", DF_2997);
  assert.equal(frames, 107892);
  assert.ok(Math.abs(seconds - (107892 * 1001 / 30000)) < 1e-10);
  assert.ok(Math.abs(seconds - 3599.9964) < 1e-9);
  assert.ok(Math.abs(seconds - 3600) > 0.003);
  assert.notEqual(seconds, frames / 29.97);
  assert.notEqual(seconds, frames / 30);
});

test("non-drop 29.97 remains nominal clock timecode", () => {
  const seconds = TC.timecodeToSeconds("01:00:00:00", NDF_2997);
  assert.ok(Math.abs(seconds - (108000 * 1001 / 30000)) < 1e-10);
  assert.ok(Math.abs(seconds - 3603.6) < 1e-9);
});

test("drop-frame round-trips across multiple hours", () => {
  for (let frame = 0; frame <= 500000; frame += 97) {
    const timecode = TC.framesToTimecode(frame, DF_2997);
    assert.equal(TC.timecodeToFrames(timecode, DF_2997), frame, timecode);
  }
});

test("59.94 drop-frame uses four skipped labels and 60000/1001", () => {
  const domain = { rate: 59.94, dropFrame: true };
  assert.throws(() => TC.timecodeToFrames("00:01:00;03", domain), /不存在/);
  assert.equal(TC.timecodeToFrames("00:01:00;04", domain), 3600);
  assert.equal(TC.framesToTimecode(3600, domain), "00:01:00;04");
  const oneHour = TC.timecodeToSeconds("01:00:00;04", domain);
  assert.ok(Math.abs(oneHour - (215788 * 1001 / 60000)) < 1e-10);
});
