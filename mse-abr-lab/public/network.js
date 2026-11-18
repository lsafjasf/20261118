(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NetworkSimulator = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function mulberry32(seed) {
    let value = seed >>> 0;
    return function random() {
      value += 0x6D2B79F5;
      let t = value;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function createNetworkSimulator(options = {}) {
    const random = mulberry32(options.seed ?? 42);
    const profiles = {
      none: { bandwidthBps: Infinity, jitter: 0, latencyMs: 0 },
      slow: {
        bandwidthBps: 2_200_000,
        jitter: 0.12,
        latencyMs: 120,
        cycleMs: 16_000,
        dipMs: 6_000,
        dipBps: 500_000,
      },
      jitter: { bandwidthBps: 4_000_000, jitter: 0.75, latencyMs: 40 },
    };

    let profileName = options.profile ?? 'none';
    let override = null;
    let overrideUntil = 0;

    function currentParams() {
      const base = profiles[profileName] || profiles.none;
      const now = Date.now();
      if (override && now < overrideUntil) return override;
      if (override && now >= overrideUntil) override = null;
      if (base.cycleMs && now % base.cycleMs < base.dipMs) {
        return { ...base, bandwidthBps: base.dipBps, jitter: 0.1 };
      }
      return base;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
    }

    async function throttledFetch(url) {
      const params = currentParams();
      await sleep(params.latencyMs);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const buffer = await response.arrayBuffer();

      if (!Number.isFinite(params.bandwidthBps)) {
        return { buffer, throughputBps: buffer.byteLength * 8 / 0.001, elapsedMs: 1 };
      }
      const factor = 1 + (random() * 2 - 1) * params.jitter;
      const effectiveBps = Math.max(50_000, params.bandwidthBps * factor);
      const chunkMs = 40;
      const bytesPerChunk = effectiveBps / 8 * (chunkMs / 1000);
      const chunkCount = Math.max(1, Math.ceil(buffer.byteLength / bytesPerChunk));
      for (let index = 0; index < chunkCount; index += 1) {
        await sleep(chunkMs);
      }
      const elapsedMs = chunkCount * chunkMs;
      return {
        buffer,
        throughputBps: (buffer.byteLength * 8 * 1000) / elapsedMs,
        elapsedMs,
        effectiveBps,
      };
    }

    return {
      fetch: throttledFetch,
      setProfile(name) {
        if (!profiles[name]) throw new Error(`unknown profile ${name}`);
        profileName = name;
        override = null;
      },
      getProfile: () => profileName,
      injectBurst(bandwidthBps, durationMs, jitter = 0.1) {
        override = { bandwidthBps, jitter, latencyMs: 40 };
        overrideUntil = Date.now() + durationMs;
      },
      params: currentParams,
    };
  }

  return { createNetworkSimulator };
});
