// Headless verification harness (no browser required).
// Runs the same MediaClient used by the UI against the local server and checks:
//   1. frames flow in both buffer tiers;
//   2. low tier keeps lower end-to-end latency;
//   3. high tier suffers fewer stutter (gap) events;
//   4. the reorder buffer never exceeds its hard cap;
//   5. retained heap does not grow over time (after forced GC);
//   6. reordering and expiry actually happen under the injected impairment.

import { WebTransport, quicheLoaded } from '@fails-components/webtransport'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MediaClient } from '../public/media-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const endpoint = process.env.WT_URL ?? 'https://127.0.0.1:8080/media'
const fingerprint =
  process.env.CERT_FP ??
  readFileSync(join(ROOT, 'cert', 'fingerprint.txt'), 'utf8').trim()

const PHASE_MS = 8000
const PHASES = ['low', 'high', 'low']
const TOTAL_MS = PHASE_MS * PHASES.length + 2000

const samples = []
let lastMetrics = null

const client = new MediaClient({
  wtUrl: endpoint,
  fingerprint,
  config: (
    await import('../public/shared/config.js')
  ).DEFAULT_CONFIG,
  WebTransportImpl: WebTransport,
  onFrame: () => {},
  onMetrics: (metrics) => {
    lastMetrics = metrics
    samples.push({ t: Date.now(), ...metrics })
  }
})

function phaseFor(elapsedMs) {
  return PHASES[Math.min(PHASES.length - 1, Math.floor(elapsedMs / PHASE_MS))]
}

function aggregate(tier) {
  // Ignore the first 2 s of every phase: frames already buffered under the
  // previous tier would otherwise contaminate the steady-state numbers.
  const phaseStarts = []
  let prevTier = null
  samples.forEach((sample, index) => {
    if (sample.tier !== prevTier) {
      phaseStarts.push({ tier: sample.tier, startIndex: index, startTime: sample.t })
      prevTier = sample.tier
    }
  })
  const rows = samples.filter(
    (sample) =>
      sample.tier === tier &&
      phaseStarts.some(
        (phase) =>
          phase.tier === tier &&
          sample.t >= phase.startTime + 2000 &&
          sample.t < phase.startTime + PHASE_MS
      )
  )
  if (rows.length === 0) return null
  const sum = (key) => rows.reduce((acc, row) => acc + row[key], 0)
  const first = rows[0]
  const last = rows[rows.length - 1]
  return {
    rows: rows.length,
    // e2eMeanMs/e2eP95Ms now only cover frames played in the current tier, so
    // averaging the steady-state samples is representative.
    latencyMean: sum('e2eMeanMs') / rows.length,
    latencyP95Max: Math.max(...rows.map((row) => row.e2eP95Ms)),
    reorderRate: sum('outOfOrderRate') / rows.length,
    expiredDelta: last.expiredFrames - first.expiredFrames,
    gapDelta: last.gapSkips - first.gapSkips,
    playedDelta: last.playedFrames - first.playedFrames,
    maxBuffer: Math.max(...rows.map((row) => row.maxBufferObserved)),
    bufferLimit: last.bufferLimit
  }
}

function forceHeapMb() {
  if (typeof global.gc !== 'function') return NaN
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed / 1024 / 1024
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

async function main() {
  await quicheLoaded
  await client.connect()
  console.log('connected, starting phased run')

  const startedAt = Date.now()
  const heapMarks = []
  let currentTier = 'low'

  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const tier = phaseFor(elapsed)
    if (tier !== currentTier) {
      currentTier = tier
      client.setTier(tier)
      console.log(`-> switch tier to ${tier} at ${elapsed} ms`)
    }
    if (elapsed % 4000 < 600) {
      const mark = forceHeapMb()
      if (Number.isFinite(mark)) heapMarks.push({ elapsed, heapMb: mark })
    }
  }, 500)

  await new Promise((resolve) => setTimeout(resolve, TOTAL_MS))
  clearInterval(timer)

  const finalMetrics = client.snapshotMetrics()
  const low = aggregate('low')
  const high = aggregate('high')

  console.log('\n=== aggregate by tier ===')
  console.table([
    { tier: 'low', ...low },
    { tier: 'high', ...high }
  ])
  console.log('final metrics:', finalMetrics)

  const checks = []
  checks.push([
    'frames were played in both tiers',
    low.playedDelta > 10 && high.playedDelta > 10
  ])
  checks.push([
    'reordering observed (non-zero out-of-order rate)',
    low.reorderRate > 0.05
  ])
  checks.push([
    'expiry happened under low buffering',
    low.expiredDelta > 0
  ])
  checks.push([
    'buffer never exceeded its cap',
    low.maxBuffer <= low.bufferLimit && high.maxBuffer <= high.bufferLimit
  ])
  checks.push([
    'high tier reduces stutter vs low tier',
    high.gapDelta <= low.gapDelta
  ])
  checks.push([
    'low tier favors timeliness (mean latency lower)',
    low.latencyMean < high.latencyMean
  ])

  if (heapMarks.length >= 4) {
    const firstHalf = heapMarks.slice(0, Math.floor(heapMarks.length / 2))
    const secondHalf = heapMarks.slice(Math.floor(heapMarks.length / 2))
    const avg = (rows) =>
      rows.reduce((acc, row) => acc + row.heapMb, 0) / rows.length
    const drift = avg(secondHalf) - avg(firstHalf)
    console.log('\nheap (MB after forced GC):', heapMarks)
    console.log(`heap drift second-half minus first-half: ${drift.toFixed(2)} MB`)
    checks.push(['heap stays flat (drift < 4 MB)', drift < 4])
  }

  console.log('\n=== checks ===')
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) fail(name)
  }

  await client.close()
  setTimeout(() => process.exit(process.exitCode ?? 0), 300)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
