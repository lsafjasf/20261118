import test from "node:test";
import assert from "node:assert/strict";
import { readVint, writeVint } from "../src/ebml.js";

test("writeVint round-trips values including multi-byte timecodes", () => {
  for (const value of [0, 1, 126, 127, 128, 1000, 2999, 16382, 16383, 60000]) {
    const encoded = writeVint(value);
    const decoded = readVint(encoded, 0);
    assert.equal(decoded.value, value, `value ${value}`);
    assert.equal(decoded.length, encoded.length, `length for ${value}`);
  }

  // Regression: 1000 must encode to two bytes 0x43 0xe8, not collapse to 0.
  assert.deepEqual([...writeVint(1000)], [0x43, 0xe8]);
  assert.deepEqual([...writeVint(0)], [0x80]);
});
