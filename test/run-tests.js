const assert = require("assert");
const Features = require("../src/features.js");
const VAD = require("../src/vad.js");
const Metrics = require("../src/metrics.js");
const TestSignal = require("../src/test-signal.js");
const FFT = require("../src/fft.js");

function fftCheck() {
  const fft = new FFT(8);
  const re = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
  const im = new Float32Array(8);
  fft.run(re, im);
  for (let k = 0; k < 8; k++) assert.ok(Math.abs(re[k] - 1) < 1e-6, "DC impulse flat spectrum");
}

function featureSanity(fixture) {
  const result = Features.extract(fixture.samples, { sampleRate: fixture.sampleRate });
  assert.ok(result.frames.length > 1500, "frames exist for 20s audio");
  const speechFrame = result.frames.find((f) => f.start > 2 && f.end < 3);
  const silenceFrame = result.frames.find((f) => f.start > 0.2 && f.end < 0.9);
  assert.ok(speechFrame.energyDb > silenceFrame.energyDb + 15, "speech much louder than silence");
  assert.ok(speechFrame.flatness < 0.5, "harmonic speech has low flatness");
  return result;
}

function clickRejection(fixture, featureResult) {
  const clickIdx = featureResult.frames.findIndex(
    (f) => f.start <= 6.55 && f.end >= 6.55
  );
  const clickFrame = featureResult.frames[clickIdx];
  assert.ok(clickFrame.zcr > 0.38 || clickFrame.flatness >= 0.5,
    "lone click is broadband/high-ZCR (rejected by guard)");
  const around = featureResult.frames.filter((f) => f.start > 6.45 && f.end < 6.7);
  assert.ok(around.every((f) => f.flatness >= 0.5 || f.zcr > 0.38 || f.energyDb < -40),
    "no click frame looks like harmonic speech");
}

function main() {
  fftCheck();
  const fixture = TestSignal.generate();
  const featureResult = featureSanity(fixture);
  clickRejection(fixture, featureResult);
  const vad = VAD.analyze(featureResult);
  const hypFrameLabels = vad.labels.map((l) => (l === "speech" ? "speech" : "silence"));
  const metrics = Metrics.evaluate(fixture.groundTruth, vad.segments, featureResult.frames,
    { hypFrameLabels });
  const totals = Metrics.totalsByLabel(vad.segments);

  console.log("== Fixed fixture ==");
  console.log(fixture.description);
  console.log("ground-truth segments:", fixture.groundTruth.length,
    "| keyboard clicks:", fixture.events.length);
  console.log("\n== Adaptive thresholds ==");
  console.log(vad.thresholds);
  console.log("\n== Detected segments ==");
  for (const s of vad.segments) {
    console.log(
      s.label.padEnd(7),
      s.start.toFixed(3).padStart(7), "->", s.end.toFixed(3).padStart(7),
      "(", (s.end - s.start).toFixed(3), "s )"
    );
  }
  console.log("\n== Totals (auto) ==", totals);
  console.log("\n== Metrics vs ground truth ==");
  console.log("frame count        :", metrics.frameCount);
  console.log("miss rate 漏检     :", metrics.missRate + "%");
  console.log("false alarm 误检   :", metrics.falseAlarmRate + "%");
  console.log("frame accuracy     :", metrics.frameAccuracy + "%");
  console.log("boundary tolerance :", metrics.boundary.toleranceSec + "s");
  console.log("matched edges      :", metrics.boundary.matchedEdges);
  console.log("bridged (merged)   :", metrics.boundary.bridgedEdges);
  console.log("missed/false edges :", metrics.boundary.missedEdges, "/", metrics.boundary.falseEdges);
  console.log("mean |boundary err|:", metrics.boundary.meanAbsErrorSec, "s");
  console.log("max  |boundary err|:", metrics.boundary.maxAbsErrorSec, "s");

  // Ground truth lists every raw speech block; the VAD is required to merge
  // blocks separated by <= maxPauseMs, so compare against merged reference.
  const maxGap = (vad.config.maxPauseMs || 250) / 1000;
  const gtMerged = [];
  for (const s of fixture.groundTruth.filter((x) => x.label === "speech")) {
    const prev = gtMerged[gtMerged.length - 1];
    if (prev && s.start - prev.end <= maxGap) prev.end = s.end;
    else gtMerged.push(Object.assign({}, s));
  }
  const gtSpeech = gtMerged.length;
  const hypSpeech = vad.segments.filter((s) => s.label === "speech").length;
  assert.strictEqual(hypSpeech, gtSpeech,
    "speech segment count matches ground truth (clicks rejected, pauses merged)");
  // Keyboard clicks never produce a speech frame at their own time instant.
  for (const ev of fixture.events) {
    const covering = featureResult.frames.filter(
      (f) => ev.start >= f.start - 0.005 && ev.start < f.end + 0.005);
    assert.ok(covering.length > 0, "click instant is covered by frames");
    const triggered = covering.some((f) =>
      f.energyDb > vad.thresholds.speechEnergyThr &&
      f.flatness < vad.config.flatnessThr &&
      !(f.flatness >= vad.config.flatnessThr && f.zcr > vad.config.zcrHigh));
    assert.ok(!triggered, "click at " + ev.start + "s does not start speech");
  }
  // The 220ms / 180ms short pauses are bridged into one continuous segment.
  const firstSpeech = vad.segments.find((s) => s.label === "speech");
  assert.ok(firstSpeech.start <= 1.05 && firstSpeech.end >= 6.3,
    "three utterances with short pauses merged into one segment");
  assert.ok(metrics.missRate < 5, "miss rate under 5%");
  assert.ok(metrics.falseAlarmRate < 3, "false alarm under 3%");
  assert.ok(metrics.boundary.meanAbsErrorSec < 0.08, "mean boundary drift under 80ms");
  console.log("\nAll assertions passed.");
}

main();
