// Central tuning knobs. Shared by the Node server and the browser/headless client.

export const DEFAULT_CONFIG = {
  // Frame production rate.
  frameIntervalMs: 50, // 20 fps
  framePayloadBytes: 512,

  // Artificial network impairment applied on the server before sending.
  network: {
    delayMinMs: 30,
    delayMaxMs: 150, // wide spread so frames overtake each other
    reorderProbability: 0.4, // chance a frame is additionally delayed
    reorderExtraDelayMs: 200,
    lossProbability: 0.05
  },

  // Bounded reorder buffer tiers (number of frames held, not bytes).
  bufferTiers: {
    low: 3,
    high: 10
  },

  // Frames older than this on arrival are dropped as expired.
  expiryMs: 500,

  // Target buffering delay used when computing playout deadlines.
  playoutDelayMs: 90,
  tierPlayoutDelayMs: {
    low: 90,
    high: 420
  }
}

export function tierLimit(config, tier) {
  const limit = config.bufferTiers[tier]
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`unknown buffer tier: ${tier}`)
  }
  return limit
}
