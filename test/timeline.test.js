import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCueModel,
  cueAtTime,
  cueForSegment,
  playbackState,
  toCsv
} from "../src/timeline.js";

const sample = await readFile(new URL("../media/stream/demo.m3u8", import.meta.url), "utf8");

test("demo manifest normalizes pre-roll, mid-roll and the skewed cue", () => {
  const model = buildCueModel(sample, { source: "media/stream/demo.m3u8" });

  assert.equal(model.totalDuration, 48);
  assert.equal(model.segments.length, 16);
  assert.equal(model.summary.cueCount, 3);
  assert.equal(model.summary.preRollCount, 1);
  assert.equal(model.summary.midRollCount, 2);
  assert.equal(model.summary.adDuration, 30);
  assert.equal(model.summary.contentDuration, 18);
  assert.equal(model.summary.errors, 0);
  assert.equal(model.summary.warnings, 1);

  assert.deepEqual(
    model.cues.map(cue => [
      cue.start, cue.end, cue.actualDuration, cue.declaredDuration, cue.returnSegmentIndex
    ]),
    [
      [0, 6, 6, 6, 2],
      [12, 24, 12, 12, 8],
      [30, 42, 12, 14, 14]
    ]
  );
  assert.equal(model.cues[2].durationDelta, -2);
  assert.equal(model.diagnostics[0].code, "CUE_DURATION_MISMATCH");
  assert.equal(model.checks.find(check => check.id === "return").status, "warn");
});

test("media time lookup maps active cue and fragment boundaries", () => {
  const model = buildCueModel(sample, { source: "demo.m3u8" });

  assert.equal(cueAtTime(model, 3)?.id, "cue-1");
  assert.equal(cueAtTime(model, 6), null);
  assert.equal(cueAtTime(model, 18.959)?.id, "cue-2");
  assert.equal(cueForSegment(model, 6)?.id, "cue-2");
  assert.equal(cueForSegment(model, 8), null);

  const state = playbackState(model, 18.959);
  assert.equal(state.phase, "ad");
  assert.equal(state.label, "cue-2 · AD");
  assert.equal(state.remaining, 5.041);
});

test("overlapping cue-out is reported and the previous break is closed", () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:3
#EXT-X-CUE-OUT:6.000
#EXTINF:3,
a.ts
#EXT-X-CUE-OUT:9.000
#EXTINF:3,
b.ts
#EXT-X-CUE-IN
#EXTINF:3,
c.ts
#EXT-X-ENDLIST`;
  const model = buildCueModel(playlist, { source: "overlap.m3u8" });

  assert.equal(model.cues.length, 2);
  assert.equal(model.cues[0].end, 3);
  assert.equal(model.cues[0].endReason, "overlap");
  assert.ok(model.diagnostics.some(item => item.code === "CUE_OVERLAP"));
  assert.equal(model.checks.find(check => check.id === "overlap").status, "fail");
});

test("cue that declares an end past the media duration is out of bounds", () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:3
#EXT-X-CUE-OUT:DURATION=12.000
#EXTINF:3,
a.ts
#EXTINF:3,
b.ts
#EXT-X-ENDLIST`;
  const model = buildCueModel(playlist, { source: "bounds.m3u8" });

  assert.ok(model.diagnostics.some(item => item.code === "CUE_OUT_OF_BOUNDS"));
  assert.equal(model.checks.find(check => check.id === "bounds").status, "fail");
  assert.equal(model.cues[0].end, 6);
});

test("CSV export preserves normalized event columns", () => {
  const model = buildCueModel(sample, { source: "demo.m3u8" });
  const csv = toCsv(model);

  assert.match(csv, /"id","kind","start_media_s"/);
  assert.match(csv, /"cue-3","mid-roll","30.000","42.000","12.000","14.000","-2.000"/);
});
