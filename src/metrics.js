/* Detection metrics vs fixed ground truth: miss/false-alarm + boundary drift. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Metrics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function labelAt(segments, t) {
    for (const s of segments) {
      if (t >= s.start && t < s.end) return s.label;
    }
    const last = segments[segments.length - 1];
    return last && t >= last.start && t <= last.end ? last.label : "silence";
  }

  function frameLabels(segments, frames) {
    return frames.map((f) => labelAt(segments, (f.start + f.end) / 2));
  }

  function pct(x) {
    return Number((x * 100).toFixed(2));
  }

  function boundaries(segments, label) {
    return segments
      .filter((s) => s.label === label)
      .flatMap((s) => [
        { edge: "start", time: s.start, segment: s },
        { edge: "end", time: s.end, segment: s }
      ]);
  }

  // Greedy nearest-neighbor matching within tolerance. Reference edges that
  // fall inside a hypothesis speech segment are short pauses bridged by
  // design (counted separately, zero drift); only outer mismatches are errors.
  function boundaryErrors(refSegs, hypSegs, toleranceSec) {
    const ref = boundaries(refSegs, "speech").sort((a, b) => a.time - b.time);
    const hyp = boundaries(hypSegs, "speech").sort((a, b) => a.time - b.time);
    const usedHyp = new Set();
    const diffs = [];
    const unmatchedRef = [];
    let bridgedEdges = 0;
    for (const r of ref) {
      const insideSpeech = hypSegs.some((s) => s.label === "speech" &&
        r.time > s.start + 1e-6 && r.time < s.end - 1e-6);
      if (insideSpeech) { bridgedEdges++; continue; }
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < hyp.length; i++) {
        if (usedHyp.has(i) || hyp[i].edge !== r.edge) continue;
        const d = Math.abs(hyp[i].time - r.time);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      if (best >= 0 && bestDist <= toleranceSec) {
        usedHyp.add(best);
        diffs.push(bestDist);
      } else {
        unmatchedRef.push(r);
      }
    }
    const falseHyp = hyp.filter((_, i) => !usedHyp.has(i));
    const mean = diffs.length
      ? diffs.reduce((a, b) => a + b, 0) / diffs.length
      : null;
    return {
      toleranceSec,
      matchedEdges: diffs.length,
      bridgedEdges,
      missedEdges: unmatchedRef.length,
      falseEdges: falseHyp.length,
      meanAbsErrorSec: mean === null ? null : Number(mean.toFixed(4)),
      maxAbsErrorSec: diffs.length ? Number(Math.max(...diffs).toFixed(4)) : null,
      errors: diffs.map(Number)
    };
  }

  // refSegments/hypSegments: [{start,end,label}], label in speech|noise|silence
  function evaluate(reference, hypothesis, frames, opts) {
    const toleranceSec = (opts && opts.toleranceSec) || 0.1;
    const ref = frameLabels(reference, frames);
    // Prefer raw per-frame labels when available: bridging short pauses into
    // one editable segment must not count those pause frames as false alarms.
    const hyp = (opts && opts.hypFrameLabels) ? opts.hypFrameLabels
      : frameLabels(hypothesis, frames);
    const cm = { speech: { speech: 0, other: 0 }, nonspeech: { speech: 0, other: 0 } };
    let total = frames.length;
    for (let i = 0; i < total; i++) {
      const rSpeech = ref[i] === "speech";
      const hSpeech = hyp[i] === "speech";
      if (rSpeech && hSpeech) cm.speech.speech++;
      else if (rSpeech) cm.speech.other++;
      else if (hSpeech) cm.nonspeech.speech++;
      else cm.nonspeech.other++;
    }
    const speechFrames = cm.speech.speech + cm.speech.other;
    const nonSpeechFrames = cm.nonspeech.speech + cm.nonspeech.other;
    const missRate = speechFrames ? cm.speech.other / speechFrames : 0;
    const falseAlarmRate = nonSpeechFrames ? cm.nonspeech.speech / nonSpeechFrames : 0;
    const correctFrames = cm.speech.speech + cm.nonspeech.other;
    const be = boundaryErrors(reference, hypothesis, toleranceSec);
    return {
      frameCount: total,
      confusionMatrix: cm,
      missRate: pct(missRate), // 漏检率 (%) of true speech frames missed
      falseAlarmRate: pct(falseAlarmRate), // 误检率 (%) of non-speech frames flagged
      frameAccuracy: pct(correctFrames / total),
      boundary: be
    };
  }

  function totalsByLabel(segments) {
    const totals = { speech: 0, noise: 0, silence: 0 };
    for (const s of segments) {
      totals[s.label] = (totals[s.label] || 0) + (s.end - s.start);
    }
    return {
      speechSec: Number(totals.speech.toFixed(3)),
      noiseSec: Number(totals.noise.toFixed(3)),
      silenceSec: Number(totals.silence.toFixed(3)),
      totalSec: Number((totals.speech + totals.noise + totals.silence).toFixed(3))
    };
  }

  return { evaluate, totalsByLabel, labelAt, frameLabels };
});
