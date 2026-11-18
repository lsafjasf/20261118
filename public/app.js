import { MediaClient } from './media-client.js'

const $ = (id) => document.getElementById(id)
const fmtMs = (value) => `${value.toFixed(1)} ms`
const fmtPct = (value) => `${(value * 100).toFixed(1)}%`

function logEvent(text, cls = '') {
  const line = document.createElement('div')
  if (cls) line.className = cls
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`
  const box = $('log')
  box.prepend(line)
  while (box.childElementCount > 40) box.lastChild.remove()
}

function renderFrame(frame, e2eMs) {
  const stage = $('stage')
  const tile = document.createElement('div')
  tile.className = 'frame-tile'
  tile.textContent = frame.seq
  tile.style.left = `${(frame.seq % 10) * 30 + 8}px`
  tile.style.top = `${Math.floor(frame.seq / 10) % 7 * 30 + 8}px`
  tile.title = `seq=${frame.seq}, e2e=${e2eMs.toFixed(1)}ms`
  stage.appendChild(tile)
  while (stage.childElementCount > 70) stage.firstChild.remove()
}

async function main() {
  const { wtUrl, fingerprint, config } = await (
    await fetch('/config.json')
  ).json()

  const client = new MediaClient({
    wtUrl,
    fingerprint,
    config,
    WebTransportImpl: window.WebTransport,
    onFrame: renderFrame,
    onMetrics: (m) => {
      $('m-latency-mean').textContent = fmtMs(m.e2eMeanMs)
      $('m-latency-p95').textContent = fmtMs(m.e2eP95Ms)
      $('m-reorder').textContent = fmtPct(m.outOfOrderRate)
      $('m-expired').textContent = String(m.expiredFrames)
      $('m-gap').textContent = String(m.gapSkips)
      $('m-buffer').textContent = `${m.bufferSize} / ${m.bufferLimit}`
      $('m-played').textContent = `${m.playedFrames} / ${m.receivedFrames}`
      $('m-offset').textContent = fmtMs(m.clockOffsetMs)
    }
  })

  const lowBtn = $('tier-low')
  const highBtn = $('tier-high')
  lowBtn.addEventListener('click', () => {
    client.setTier('low')
    lowBtn.classList.add('active')
    highBtn.classList.remove('active')
    logEvent('切换到低缓冲档（容量 2，优先保时效）', 'warn')
  })
  highBtn.addEventListener('click', () => {
    client.setTier('high')
    lowBtn.classList.remove('active')
    highBtn.classList.add('active')
    logEvent('切换到高缓冲档（容量 8，优先减少断帧）', 'good')
  })

  try {
    await client.connect()
    $('status').innerHTML = '<span class="pill">已连接</span>'
    logEvent(`WebTransport 已连接：${wtUrl}`)
  } catch (error) {
    $('status').textContent = `连接失败：${error.message}`
    logEvent(`连接失败：${error.message}`, 'bad')
  }
}

main()
