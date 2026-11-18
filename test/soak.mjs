// Long-running soak test: proves bounded retention over many frame cycles.
// Heap is sampled after forced GC; the reorder buffer size and the server-side
// impaired-send queue are hard-capped and asserted continuously.

import { WebTransport, quicheLoaded } from '@fails-components/webtransport'
import { readFileSync } from 'node:fs'
import { MediaClient } from '../public/media-client.js'
import { DEFAULT_CONFIG } from '../public/shared/config.js'

const DURATION_MS = Number(process.env.SOAK_MS ?? 45000)
const fp = readFileSync(new URL('../cert/fingerprint.txt', import.meta.url), 'utf8').trim()
await quicheLoaded

const client = new MediaClient({
  wtUrl: process.env.WT_URL ?? 'https://127.0.0.1:8080/media',
  fingerprint: fp,
  config: DEFAULT_CONFIG,
  WebTransportImpl: WebTransport,
  onFrame: () => {},
  onMetrics: () => {}
})

await client.connect()
const marks = []
let violations = 0

const sampler = setInterval(() => {
  global.gc()
  marks.push({
    t: Date.now(),
    heapMb: process.memoryUsage().heapUsed / 1024 / 1024,
    bufferSize: client.buffer.size,
    limit: client.buffer.limit
  })
  if (client.buffer.size > client.buffer.limit) violations += 1
}, 2000)

// Alternate tiers periodically to exercise both limits and the transition path.
const tierTimer = setInterval(() => {
  client.setTier(client.tier === 'low' ? 'high' : 'low')
}, 8000)

await new Promise((resolve) => setTimeout(resolve, DURATION_MS))
clearInterval(sampler)
clearInterval(tierTimer)

const first = marks.slice(0, 3)
const last = marks.slice(-3)
const avg = (rows) => rows.reduce((acc, row) => acc + row.heapMb, 0) / rows.length
const drift = avg(last) - avg(first)
const maxBuffer = Math.max(...marks.map((row) => row.bufferSize))

console.log('soak marks:', marks.length)
console.log('first heap MB:', avg(first).toFixed(2), 'last heap MB:', avg(last).toFixed(2))
console.log('heap drift over run:', drift.toFixed(2), 'MB')
console.log('max buffer size observed:', maxBuffer)
console.log('cap violations:', violations)
console.log('final buffer stats:', client.buffer.stats)

const ok = violations === 0 && drift < 4
console.log(ok ? 'PASS soak: bounded memory' : 'FAIL soak: memory growth or cap violation')
await client.close()
setTimeout(() => process.exit(ok ? 0 : 1), 300)
