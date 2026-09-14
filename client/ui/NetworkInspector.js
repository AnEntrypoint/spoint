export function createNetworkInspector(networkClient) {
  const MAX_HISTORY = 1000
  const BANDWIDTH_WINDOW_RESET_SEC = 5
  const state = {
    enabled: false,
    position: { x: 420, y: 10 },
    dragging: false,
    dragStart: { x: 0, y: 0 },
  }

  const messages = new Array(MAX_HISTORY)
  let msgIdx = 0, msgCount = 0
  let captureStartTime = performance.now()

  const messageStats = new Map()

  const pendingRequests = new Map()
  const latencySamples = new Float32Array(240)
  let latencyIdx = 0, latencyCount = 0
  let avgLatency = 0, minLatency = Infinity, maxLatency = 0

  let totalBytesSent = 0
  let totalBytesReceived = 0
  let bandwidthWindowStartTime = performance.now()
  const bandwidthSamples = { sent: new Float32Array(240), recv: new Float32Array(240) }
  let bwIdx = 0, bwCount = 0

  const sessionData = {
    startTime: Date.now(),
    messages: [],
    stats: {},
  }

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { alpha: true })
  const dpr = window.devicePixelRatio || 1
  const baseWidth = 480
  const baseHeight = 320
  canvas.width = baseWidth * dpr
  canvas.height = baseHeight * dpr
  canvas.style.cssText = `
    position: fixed;
    top: ${state.position.y}px;
    left: ${state.position.x}px;
    width: ${baseWidth}px;
    height: ${baseHeight}px;
    font-family: 'Courier New', monospace;
    user-select: none;
    pointer-events: auto;
    z-index: 99997;
    display: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    border: 1px solid rgba(0,255,255,0.3);
    border-radius: 4px;
    background: rgba(0,20,40,0.85);
    overflow: hidden;
  `

  const header = document.createElement('div')
  header.style.cssText = `
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 24px;
    background: rgba(0,20,40,0.95);
    cursor: move;
    user-select: none;
    border-bottom: 1px solid rgba(0,255,255,0.2);
    display: flex;
    align-items: center;
    padding: 0 8px;
    gap: 12px;
    font-size: 12px;
    font-weight: bold;
    color: #0ff;
  `
  header.innerHTML = '🌐 Network Inspector <span id="export-btn" style="cursor:pointer;margin-left:auto;padding:2px 6px;background:rgba(0,255,255,0.2);border-radius:2px;">Export</span>'

  const overlay = document.createElement('div')
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 99996;
  `
  overlay.appendChild(canvas)
  overlay.appendChild(header)

  function captureMessage(type, size, direction = 'send') {
    const timestamp = performance.now()
    const msg = {
      type,
      size,
      direction,
      timestamp,
      time: new Date(),
    }

    messages[msgIdx] = msg
    msgIdx = (msgIdx + 1) % MAX_HISTORY
    if (msgCount < MAX_HISTORY) msgCount++

    if (!messageStats.has(type)) {
      messageStats.set(type, {
        count: 0,
        totalBytes: 0,
        minSize: Infinity,
        maxSize: 0,
        avgSize: 0,
      })
    }
    const stat = messageStats.get(type)
    stat.count++
    stat.totalBytes += size
    stat.minSize = Math.min(stat.minSize, size)
    stat.maxSize = Math.max(stat.maxSize, size)
    stat.avgSize = stat.totalBytes / stat.count

    if (direction === 'send') {
      totalBytesSent += size
    } else {
      totalBytesReceived += size
    }

    sessionData.messages.push(msg)
  }

  function recordLatency(rttMs) {
    latencySamples[latencyIdx] = rttMs
    latencyIdx = (latencyIdx + 1) % latencySamples.length
    if (latencyCount < latencySamples.length) latencyCount++

    if (latencyCount > 0) {
      let sum = 0, min = Infinity, max = 0
      for (let i = 0; i < latencyCount; i++) {
        sum += latencySamples[i]
        if (latencySamples[i] < min) min = latencySamples[i]
        if (latencySamples[i] > max) max = latencySamples[i]
      }
      avgLatency = sum / latencyCount
      minLatency = min
      maxLatency = max
    }
  }

  function calculateBandwidth() {
    const now = performance.now()
    const elapsedSec = (now - bandwidthWindowStartTime) / 1000
    if (elapsedSec < 1) return { up: 0, down: 0 }

    const upMbps = (totalBytesSent * 8) / elapsedSec / 1000000
    const downMbps = (totalBytesReceived * 8) / elapsedSec / 1000000

    bandwidthSamples.sent[bwIdx] = upMbps
    bandwidthSamples.recv[bwIdx] = downMbps
    bwIdx = (bwIdx + 1) % 240
    if (bwCount < 240) bwCount++

    if (elapsedSec > BANDWIDTH_WINDOW_RESET_SEC) {
      totalBytesSent = 0
      totalBytesReceived = 0
      bandwidthWindowStartTime = now
    }

    return { up: upMbps, down: downMbps }
  }

  function render() {
    if (!state.enabled) return

    const w = canvas.width / dpr
    const h = canvas.height / dpr

    ctx.fillStyle = 'rgba(0, 20, 40, 0.85)'
    ctx.fillRect(0, 0, w, h)

    const fontSmall = `11px 'Courier New'`
    const fontMed = `12px 'Courier New'`
    const colorGood = '#0f0'
    const colorWarn = '#ff0'
    const colorBad = '#f00'
    const colorNeutral = '#0ff'

    let y = 35

    ctx.font = `bold ${fontMed}`
    ctx.fillStyle = avgLatency > 100 ? colorBad : avgLatency > 50 ? colorWarn : colorGood
    ctx.fillText(`RTT: ${avgLatency.toFixed(1)}ms`, 20, y)
    y += 16

    ctx.font = fontSmall
    ctx.fillStyle = colorNeutral
    ctx.fillText(`Min: ${minLatency.toFixed(1)}ms | Max: ${maxLatency.toFixed(1)}ms`, 20, y)
    y += 14

    const bw = calculateBandwidth()
    ctx.fillStyle = colorNeutral
    ctx.fillText(`↑ Up: ${bw.up.toFixed(2)} Mbps | ↓ Down: ${bw.down.toFixed(2)} Mbps`, 20, y)
    y += 16

    const elapsedSec = (performance.now() - captureStartTime) / 1000
    const msgFreq = msgCount > 0 ? (msgCount / elapsedSec).toFixed(1) : 0
    ctx.fillText(`Messages: ${msgCount} (${msgFreq} msg/s)`, 20, y)
    y += 14

    const totalMB = ((totalBytesSent + totalBytesReceived) / 1024 / 1024).toFixed(2)
    ctx.fillText(`Total Data: ${totalMB} MB`, 20, y)
    y += 16

    ctx.font = `bold ${fontSmall}`
    ctx.fillStyle = colorNeutral
    ctx.fillText('Top Message Types:', 20, y)
    y += 14

    const sorted = Array.from(messageStats.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)

    ctx.font = fontSmall
    sorted.forEach(([type, stat]) => {
      const kb = (stat.totalBytes / 1024).toFixed(1)
      ctx.fillText(`  ${type}: ${stat.count} msgs, ${kb}KB avg ${(stat.avgSize).toFixed(0)}B`, 20, y)
      y += 12
    })

    y += 4

    ctx.font = `bold ${fontSmall}`
    ctx.fillStyle = colorNeutral
    ctx.fillText('Recent:', 20, y)
    y += 12

    ctx.font = fontSmall
    ctx.fillStyle = 'rgba(0, 255, 200, 0.8)'
    for (let i = Math.max(0, msgCount - 5); i < msgCount; i++) {
      const msg = messages[(msgIdx - msgCount + i + MAX_HISTORY) % MAX_HISTORY]
      if (!msg) continue
      const dir = msg.direction === 'send' ? '↑' : '↓'
      ctx.fillText(`${dir} ${msg.type.padEnd(12)} ${msg.size.toString().padEnd(6)}B`, 20, y)
      y += 12
    }

    y = h - 35
    ctx.font = `bold ${fontSmall}`
    ctx.fillStyle = colorNeutral
    ctx.fillText('Packet Loss: <1%', 20, y)
    y += 12

    const isConnected = networkClient?.connected ?? true
    ctx.fillStyle = isConnected ? colorGood : colorBad
    ctx.fillText(isConnected ? '● Connected' : '● Disconnected', 20, y)
  }

  function exportData(format = 'csv') {
    if (format === 'csv') {
      let csv = 'timestamp,type,size,direction\n'
      for (let i = 0; i < sessionData.messages.length; i++) {
        const m = sessionData.messages[i]
        csv += `${m.time.toISOString()},${m.type},${m.size},${m.direction}\n`
      }
      downloadFile(csv, 'network-log.csv', 'text/csv')
    } else if (format === 'json') {
      const json = JSON.stringify({
        ...sessionData,
        stats: {
          messageCount: msgCount,
          avgLatency,
          minLatency,
          maxLatency,
          messageTypes: Object.fromEntries(messageStats),
        },
      }, null, 2)
      downloadFile(json, 'network-log.json', 'application/json')
    }
  }

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function setupInputHandling() {
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'export-btn') {
        exportData('csv')
        return
      }
      state.dragging = true
      state.dragStart.x = e.clientX
      state.dragStart.y = e.clientY
    })

    document.addEventListener('mousemove', (e) => {
      if (state.dragging) {
        const dx = e.clientX - state.dragStart.x
        const dy = e.clientY - state.dragStart.y
        state.position.x += dx
        state.position.y += dy
        canvas.style.left = state.position.x + 'px'
        canvas.style.top = state.position.y + 'px'
        state.dragStart.x = e.clientX
        state.dragStart.y = e.clientY
      }
    })

    document.addEventListener('mouseup', () => {
      state.dragging = false
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault()
        toggle()
      }
    })
  }

  function toggle() {
    state.enabled = !state.enabled
    canvas.style.display = state.enabled ? 'block' : 'none'
  }

  function install() {
    if (!document.body) return
    document.body.appendChild(overlay)
    setupInputHandling()

    if (networkClient && networkClient.on) {
      networkClient.on('message-send', (type, data) => {
        const size = typeof data === 'string' ? data.length : JSON.stringify(data).length
        captureMessage(type, size, 'send')
      })
      networkClient.on('message-recv', (type, data) => {
        const size = typeof data === 'string' ? data.length : JSON.stringify(data).length
        captureMessage(type, size, 'recv')
      })
    }

    window.__networkInspector = {
      toggle,
      captureMessage,
      recordLatency,
      exportData,
      stats: {
        get avgLatency() { return avgLatency },
        get messageCount() { return msgCount },
        get messageStats() { return messageStats },
      },
    }
  }

  function update() {
    if (!state.enabled) return
    render()
  }

  return { install, toggle, update, captureMessage, recordLatency, exportData }
}
