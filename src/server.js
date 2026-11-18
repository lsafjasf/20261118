import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { createServer } from 'node:http'
import { Http3Server } from '@fails-components/webtransport'
import { DEFAULT_CONFIG } from '../public/shared/config.js'
import { ImpairedSender } from './network.js'
import { encodeFrame, encodeControl, decodeControl } from '../public/shared/protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const PORT = Number(process.env.WT_PORT ?? 8080)
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8081)
const HOST = process.env.WT_HOST ?? '127.0.0.1'
const CERT_DIR = process.env.CERT_DIR ?? join(ROOT, 'cert')

const config = {
  ...DEFAULT_CONFIG,
  network: { ...DEFAULT_CONFIG.network, maxPending: 64 }
}

function loadFingerprint() {
  const file = join(CERT_DIR, 'fingerprint.txt')
  if (!existsSync(file)) {
    throw new Error('missing certificate, run: npm run cert')
  }
  return readFileSync(file, 'utf8').trim()
}

const fingerprint = loadFingerprint()

const server = new Http3Server({
  port: PORT,
  host: HOST,
  secret: 'local-media-demo-secret',
  cert: readFileSync(join(CERT_DIR, 'cert.pem'), 'utf8'),
  privKey: readFileSync(join(CERT_DIR, 'key.pem'), 'utf8'),
  defaultDatagramsReadableMode: 'object'
})

const mediaPath = '/media'
const sessionStream = server.sessionStream(mediaPath)
const sessionReader = sessionStream.getReader()

async function handleSession(session) {
  await session.ready

  const writer = session.datagrams.writable.getWriter()
  const sender = new ImpairedSender(writer, config.network)
  const statsTimer = setInterval(() => {
    console.log(
      `impaired-queue pending=${sender.pendingCount} ` +
        `produced=${sender.stats.produced} sent=${sender.stats.sent} ` +
        `lost=${sender.stats.lost} queueFull=${sender.stats.queueFull}`
    )
  }, 5000)

  let stopped = false
  let seq = 0
  const payload = new Uint8Array(config.framePayloadBytes)

  const frameTimer = setInterval(() => {
    if (stopped) return
    const sendTimestamp = performance.timeOrigin + performance.now()
    sender.send(encodeFrame(seq, sendTimestamp, payload))
    seq += 1
  }, config.frameIntervalMs)

  const reader = session.datagrams.readable.getReader()
  const controlLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const control = decodeControl(value)
      if (!control) continue
      const serverTimestamp = performance.timeOrigin + performance.now()
      writer
        .write(encodeControl(control.clientTimestamp, serverTimestamp))
        .catch(() => {})
    }
  })()

  const closed = session.closed
    .then(() => undefined)
    .catch(() => undefined)
  await closed

  stopped = true
  clearInterval(frameTimer)
  clearInterval(statsTimer)
  reader.cancel().catch(() => {})
  await controlLoop.catch(() => {})
  await sender.close()
}

async function acceptSessions() {
  while (true) {
    const { done, value: session } = await sessionReader.read()
    if (done) break
    handleSession(session).catch((error) => {
      console.error('session error:', error)
    })
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
}

const staticServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname
  if (pathname === '/config.json') {
    res.writeHead(200, { 'content-type': MIME['.json'] })
    res.end(
      JSON.stringify({
        wtUrl: `https://${HOST}:${PORT}${mediaPath}`,
        fingerprint,
        config
      })
    )
    return
  }
  const file = join(ROOT, 'public', pathname.replace(/^\/+/, ''))
  if (!file.startsWith(join(ROOT, 'public')) || !existsSync(file)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

server.startServer()
acceptSessions()
staticServer.listen(HTTP_PORT, HOST, () => {
  console.log(`WebTransport: https://${HOST}:${PORT}${mediaPath}`)
  console.log(`UI:            http://${HOST}:${HTTP_PORT}/`)
  console.log(`cert hash:     ${fingerprint}`)
})

function shutdown() {
  server.stopServer()
  staticServer.close()
  setTimeout(() => process.exit(0), 100)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
