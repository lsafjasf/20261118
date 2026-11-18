(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AbrController = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const COOLDOWN_SEGMENTS = 3;
  const EMERGENCY_BUFFER = 4;
  const UPSHIFT_BUFFER = 6;
  const DOWNSHIFT_BUFFER = 14;
  const UPSHIFT_SAFETY = 1.35;
  const DOWNSHIFT_SAFETY = 1.05;
  const EWMA_ALPHA = 0.6;

  function createAbrController(renditions) {
    const tiers = renditions.map((rendition, index) => ({ ...rendition, index }));
    const state = {
      currentIndex: 0,
      lockedIndex: null,
      throughputBps: null,
      lastAutoSwitchSegment: 0,
      lastDecision: null,
      history: [],
    };

    function reportFetch(bytes, durationSeconds) {
      if (durationSeconds <= 0) return;
      const sample = (bytes * 8) / durationSeconds;
      state.throughputBps = state.throughputBps === null
        ? sample
        : EWMA_ALPHA * sample + (1 - EWMA_ALPHA) * state.throughputBps;
    }

    function record(segmentIndex, index, reason, throughputBps, bufferSeconds) {
      const decision = {
        segmentIndex,
        rendition: tiers[index].id,
        bitrate: tiers[index].bitrate,
        reason,
        throughputBps: Math.round(throughputBps || 0),
        bufferSeconds: Math.round(bufferSeconds * 100) / 100,
        at: Date.now(),
      };
      state.lastDecision = decision;
      state.history.push(decision);
      return decision;
    }

    function decide(segmentIndex, bufferSeconds) {
      const throughput = state.throughputBps;
      const current = state.currentIndex;

      if (segmentIndex === 0) {
        state.currentIndex = 0;
        return record(segmentIndex, 0, 'startup', throughput, bufferSeconds);
      }

      if (state.lockedIndex !== null) {
        if (current === state.lockedIndex) {
          return record(segmentIndex, current, 'hold-manual-lock', throughput, bufferSeconds);
        }
        state.currentIndex = state.lockedIndex;
        return record(segmentIndex, state.lockedIndex, 'manual-lock', throughput, bufferSeconds);
      }

      if (bufferSeconds < EMERGENCY_BUFFER && current > 0) {
        state.currentIndex = 0;
        state.lastAutoSwitchSegment = segmentIndex;
        return record(segmentIndex, 0, 'buffer-emergency', throughput, bufferSeconds);
      }

      if (throughput !== null && current > 0 && bufferSeconds < DOWNSHIFT_BUFFER) {
        const affordable = tiers[current].bitrate * DOWNSHIFT_SAFETY;
        if (throughput < affordable) {
          let target = 0;
          for (let index = current - 1; index >= 0; index -= 1) {
            if (tiers[index].bitrate * DOWNSHIFT_SAFETY <= throughput) {
              target = index;
              break;
            }
          }
          if (target < current) {
            state.currentIndex = target;
            state.lastAutoSwitchSegment = segmentIndex;
            return record(segmentIndex, target, 'throughput-downshift', throughput, bufferSeconds);
          }
        }
      }

      const cooldownReady = segmentIndex - state.lastAutoSwitchSegment >= COOLDOWN_SEGMENTS;

      if (current < tiers.length - 1 && cooldownReady && bufferSeconds >= UPSHIFT_BUFFER) {
        const candidate = tiers[current + 1];
        if (throughput !== null && throughput >= candidate.bitrate * UPSHIFT_SAFETY) {
          state.currentIndex = current + 1;
          state.lastAutoSwitchSegment = segmentIndex;
          return record(segmentIndex, current + 1, 'throughput-upshift', throughput, bufferSeconds);
        }
        return record(segmentIndex, current, 'hold-insufficient-throughput', throughput, bufferSeconds);
      }

      if (current === tiers.length - 1) {
        return record(segmentIndex, current, 'hold-top-tier', throughput, bufferSeconds);
      }
      if (!cooldownReady) {
        return record(segmentIndex, current, 'hold-cooldown', throughput, bufferSeconds);
      }
      return record(segmentIndex, current, 'hold-buffer-building', throughput, bufferSeconds);
    }

    function lock(index) {
      if (!Number.isInteger(index) || index < 0 || index >= tiers.length) {
        throw new Error(`invalid rendition index ${index}`);
      }
      state.lockedIndex = index;
    }

    function unlock() {
      state.lockedIndex = null;
    }

    return {
      decide,
      reportFetch,
      lock,
      unlock,
      getState: () => ({
        currentIndex: state.currentIndex,
        lockedIndex: state.lockedIndex,
        throughputBps: state.throughputBps,
        lastDecision: state.lastDecision,
        history: state.history.slice(),
      }),
    };
  }

  return { createAbrController };
});
