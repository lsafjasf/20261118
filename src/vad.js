/* Three-feature VAD: energy + zero-crossing rate + spectral flatness. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VAD = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    energyMarginDb: 9, // speech must exceed noise floor by this much
    silenceMarginDb: -4, // frames at/above the noise floor count as noise
    flatnessThr: 0.5, // harmonic speech is below; flat noise/clicks above
    zcrHigh: 0.38, // broadband impulses (keyboard) cross this
    noiseLowFraction: 0.1, // low percentile of non-transient audible frames
    maxPauseMs: 250, // short pauses inside speech get merged
    minSpeechMs: 120, // shorter speech runs are dropped (isolated clicks)
    minNonSpeechMs: 200, // smooth flicker between silence/noise
    minOnsetFrames: 3, // onset must persist this many frames
    hangoverMs: 50 // keep trailing harmonic frames after energy dips
  };

  function labelFrames(featureResult, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const { frames, hopMs } = featureResult;
    // Ignore clamped silence and broadband transient frames (keyboard clicks
    // are loud but must not inflate the ambient-noise floor), then take a low
    // percentile of the remaining energies.
    const clamp = -80;
    const audible = frames
      .filter((f) => f.energyDb > clamp + 1 &&
        !(f.flatness >= cfg.flatnessThr && f.zcr > cfg.zcrHigh))
      .map((f) => f.energyDb)
      .sort((a, b) => a - b);
    const pool = audible.length ? audible : energies;
    const noiseDb = pool[Math.floor(pool.length * cfg.noiseLowFraction)];
    const speechEnergyThr = noiseDb + cfg.energyMarginDb;
    const silenceEnergyThr = noiseDb + cfg.silenceMarginDb;

    const raw = new Array(frames.length);
    frames.forEach((f, i) => {
      const enoughEnergy = f.energyDb > speechEnergyThr;
      const harmonic = f.flatness < cfg.flatnessThr;
      const broadbandImpulse = f.flatness >= cfg.flatnessThr && f.zcr > cfg.zcrHigh;
      // Keyboard/transient guard: energetic but flat + high ZCR can never
      // start speech, even though its short-time energy is high.
      raw[i] = enoughEnergy && harmonic && !broadbandImpulse ? "speech" : "nonspeech";
    });

    // Onset confirmation: kill speech runs shorter than minOnsetFrames.
    for (let i = 0; i < raw.length; ) {
      if (raw[i] !== "speech") { i++; continue; }
      let j = i;
      while (j < raw.length && raw[j] === "speech") j++;
      if (j - i < cfg.minOnsetFrames) {
        for (let k = i; k < j; k++) raw[k] = "nonspeech";
      }
      i = j;
    }
    return { raw, noiseDb, speechEnergyThr, silenceEnergyThr, cfg };
  }

  // Fill short nonspeech gaps between speech runs (continuous short pauses
  // merge into one speech segment), then drop over-short speech runs.
  function smoothSpeech(raw, frames, cfg, judgedThresholds) {
    const labels = raw.slice();
    const hopSec = frames.length > 1 ? frames[1].start - frames[0].start : 0.01;
    const gapFrames = Math.round(cfg.maxPauseMs / (hopSec * 1000));
    const hangover = Math.round(cfg.hangoverMs / (hopSec * 1000));
    // Hangover: a harmonic low-flatness run immediately after speech stays
    // attached, so soft syllable tails are not clipped at the boundary.
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== "speech") continue;
      let end = i;
      while (end < labels.length && labels[end] === "speech") end++;
      let h = 0;
      while (end + h < labels.length && h < hangover) {
        const tail = frames[end + h];
        const harmonic = tail.flatness < cfg.flatnessThr;
        const notImpulse = !(tail.flatness >= cfg.flatnessThr && tail.zcr > cfg.zcrHigh);
        const audible = tail.energyDb > judgedThresholds.silenceEnergyThr;
        if (!harmonic || !notImpulse || !audible) break;
        labels[end + h] = "speech";
        h++;
      }
      i = end - 1; // outer loop advances to end; gaps are handled below
    }
    // Note: short internal pauses are NOT relabeled here; they are bridged
    // at segment-build time so frame-level metrics still see the true frames.
    const minRun = Math.round(cfg.minSpeechMs / (hopSec * 1000));
    for (let i = 0; i < labels.length; ) {
      if (labels[i] !== "speech") { i++; continue; }
      let j = i;
      while (j < labels.length && labels[j] === "speech") j++;
      if (j - i < minRun) for (let k = i; k < j; k++) labels[k] = "nonspeech";
      i = j;
    }
    return labels;
  }

  function buildSegments(frames, labels, silenceEnergyThr, cfg, totalDuration) {
    const hopSec0 = frames.length > 1 ? (frames[1].start - frames[0].start) : 0.01;
    const gapFrames = Math.round(cfg.maxPauseMs / (hopSec0 * 1000));
    // Bridge short nonspeech gaps between speech runs at the segment layer:
    // one continuous, editable speech segment, while frame labels stay honest.
    const bridged = labels.slice();
    for (let i = 0; i < bridged.length; i++) {
      if (bridged[i] !== "speech") continue;
      let end = i;
      while (end < bridged.length && bridged[end] === "speech") end++;
      let gap = end;
      while (gap < bridged.length && bridged[gap] === "nonspeech") gap++;
      if (gap < bridged.length && bridged[gap] === "speech" && gap - end <= gapFrames) {
        for (let k = end; k < gap; k++) bridged[k] = "speech-bridged";
      }
      i = gap - 1;
    }
    const kind = bridged.map((lab, i) =>
      (lab === "speech" || lab === "speech-bridged") ? "speech"
        : frames[i].energyDb <= silenceEnergyThr ? "silence" : "noise");
    const hopSec = frames.length > 1 ? (frames[1].start - frames[0].start) : 0.01;
    const minRun = Math.round(cfg.minNonSpeechMs / (hopSec * 1000));
    for (let i = 0; i < kind.length; ) {
      let j = i;
      while (j < kind.length && kind[j] === kind[i]) j++;
      if (kind[i] !== "speech" && j - i < minRun && i > 0 && j < kind.length) {
        for (let k = i; k < j; k++) kind[k] = kind[i - 1];
      }
      i = j;
    }
    const segments = [];
    let runStart = 0;
    for (let i = 1; i <= kind.length; i++) {
      if (i === kind.length || kind[i] !== kind[runStart]) {
        const first = frames[runStart];
        const last = frames[i - 1];
        segments.push({
          start: first.start,
          end: i === kind.length ? (totalDuration || last.end) : frames[i].start,
          label: kind[runStart]
        });
        runStart = i;
      }
    }
    return segments;
  }

  function analyze(featureResult, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const { frames } = featureResult;
    if (!frames.length) return { segments: [], labels: [], thresholds: {} };
    const judged = labelFrames(featureResult, cfg);
    const labels = smoothSpeech(judged.raw, frames, cfg, judged);
    const totalDuration = featureResult.duration || frames[frames.length - 1].end;
    const segments = buildSegments(frames, labels, judged.silenceEnergyThr, cfg, totalDuration);
    return {
      segments,
      labels,
      frames,
      thresholds: {
        noiseDb: judged.noiseDb,
        speechEnergyThr: judged.speechEnergyThr,
        silenceEnergyThr: judged.silenceEnergyThr
      },
      config: cfg
    };
  }

  return { analyze, DEFAULTS };
});
