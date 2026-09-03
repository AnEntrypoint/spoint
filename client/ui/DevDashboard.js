// DevDashboard -- Unified developer dashboard combining performance profiler, network
// inspector, and debug information. Provides resizable panels, preset configurations
// (FPS, network, memory focus), and session data export (JSON/CSV).
//
// Architecture:
// - Panel-based layout with drag-to-resize
// - Preset profiles: 'fps', 'network', 'memory', 'all'
// - Real-time metric aggregation
// - Session export with timestamp and metadata

export function createDevDashboard(profiler, networkInspector) {
  const state = {
    enabled: false,
    activePreset: 'all', // 'fps' | 'network' | 'memory' | 'all'
    panels: {
      performance: { x: 10, y: 50, w: 400, h: 280, visible: true },
      network: { x: 420, y: 50, w: 480, h: 320, visible: true },
      debug: { x: 10, y: 350, w: 890, h: 200, visible: true },
    },
    resizing: null,
  }

  const sessionStats = {
    startTime: Date.now(),
    peakFPS: 0,
    minFPS: Infinity,
    avgFPS: 0,
    peakMemory: 0,
    peakBandwidth: 0,
    totalNetworkBytes: 0,
  }

  // Create main container
  const container = document.createElement('div')
  container.id = 'dev-dashboard'
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: auto;
    z-index: 99990;
    display: none;
    background: rgba(0, 0, 0, 0.3);
    user-select: none;
  `

  // Panel structure
  const panels = {}

  function createPanel(id, title, x, y, w, h) {
    const panel = document.createElement('div')
    panel.id = `panel-${id}`
    panel.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${w}px;
      height: ${h}px;
      background: rgba(0, 20, 40, 0.9);
      border: 2px solid rgba(0, 200, 255, 0.3);
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      z-index: 99991;
      display: flex;
      flex-direction: column;
    `

    // Header
    const header = document.createElement('div')
    header.style.cssText = `
      height: 24px;
      background: rgba(0, 0, 0, 0.8);
      border-bottom: 1px solid rgba(0, 200, 255, 0.2);
      display: flex;
      align-items: center;
      padding: 0 8px;
      font-family: 'Courier New', monospace;
      font-weight: bold;
      font-size: 11px;
      color: #0ff;
      cursor: move;
      user-select: none;
      gap: 8px;
    `
    header.innerHTML = `<span>${title}</span><span id="close-${id}" style="cursor:pointer;margin-left:auto;">✕</span>`

    // Content area
    const content = document.createElement('div')
    content.style.cssText = `
      flex: 1;
      overflow: auto;
      padding: 8px;
      font-family: 'Courier New', monospace;
      font-size: 11px;
      color: #0ff;
      line-height: 1.4;
    `

    // Resize handle
    const resizer = document.createElement('div')
    resizer.style.cssText = `
      position: absolute;
      bottom: 0;
      right: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      background: linear-gradient(135deg, transparent 50%, rgba(0, 200, 255, 0.5) 50%);
    `

    panel.appendChild(header)
    panel.appendChild(content)
    panel.appendChild(resizer)
    container.appendChild(panel)

    // Dragging
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === `close-${id}`) return
      const rect = panel.getBoundingClientRect()
      const startX = e.clientX, startY = e.clientY
      const startLeft = rect.left, startTop = rect.top

      const handleMove = (e) => {
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        panel.style.left = (startLeft + dx) + 'px'
        panel.style.top = (startTop + dy) + 'px'
        state.panels[id].x = startLeft + dx
        state.panels[id].y = startTop + dy
      }

      const handleUp = () => {
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    })

    // Resizing
    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const rect = panel.getBoundingClientRect()
      const startX = e.clientX, startY = e.clientY
      const startW = rect.width, startH = rect.height

      const handleMove = (e) => {
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        const newW = Math.max(300, startW + dx)
        const newH = Math.max(150, startH + dy)
        panel.style.width = newW + 'px'
        panel.style.height = newH + 'px'
        state.panels[id].w = newW
        state.panels[id].h = newH
      }

      const handleUp = () => {
        document.removeEventListener('mousemove', handleMove)
        document.removeEventListener('mouseup', handleUp)
      }

      document.addEventListener('mousemove', handleMove)
      document.addEventListener('mouseup', handleUp)
    })

    // Close button
    document.getElementById(`close-${id}`).addEventListener('click', () => {
      state.panels[id].visible = false
      panel.style.display = 'none'
    })

    return { panel, header, content, resizer }
  }

  // Create panels
  const perfPanel = createPanel('performance', '📊 Performance', 10, 50, 400, 280)
  const netPanel = createPanel('network', '🌐 Network', 420, 50, 480, 320)
  const debugPanel = createPanel('debug', '🔧 Debug', 10, 350, 890, 200)

  panels.performance = perfPanel
  panels.network = netPanel
  panels.debug = debugPanel

  // Toolbar
  const toolbar = document.createElement('div')
  toolbar.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 40px;
    background: rgba(0, 0, 0, 0.95);
    border-bottom: 2px solid rgba(0, 200, 255, 0.3);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    color: #0ff;
    z-index: 99992;
    pointer-events: auto;
  `

  const presets = ['all', 'fps', 'network', 'memory']
  presets.forEach(preset => {
    const btn = document.createElement('button')
    btn.textContent = `📌 ${preset.toUpperCase()}`
    btn.style.cssText = `
      padding: 4px 8px;
      background: ${state.activePreset === preset ? 'rgba(0,200,255,0.3)' : 'rgba(0,100,150,0.2)'};
      border: 1px solid rgba(0, 200, 255, ${state.activePreset === preset ? '0.6' : '0.3'});
      color: #0ff;
      cursor: pointer;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 10px;
      font-weight: bold;
    `
    btn.addEventListener('click', () => {
      setPreset(preset)
    })
    toolbar.appendChild(btn)
  })

  // Export button
  const exportBtn = document.createElement('button')
  exportBtn.textContent = '💾 EXPORT'
  exportBtn.style.cssText = `
    margin-left: auto;
    padding: 4px 8px;
    background: rgba(0, 200, 100, 0.2);
    border: 1px solid rgba(0, 200, 100, 0.4);
    color: #0f0;
    cursor: pointer;
    border-radius: 3px;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    font-weight: bold;
  `
  exportBtn.addEventListener('click', exportSession)
  toolbar.appendChild(exportBtn)

  // Close button
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '✕ CLOSE'
  closeBtn.style.cssText = `
    padding: 4px 8px;
    background: rgba(200, 50, 50, 0.2);
    border: 1px solid rgba(200, 50, 50, 0.4);
    color: #f00;
    cursor: pointer;
    border-radius: 3px;
    font-family: 'Courier New', monospace;
    font-size: 10px;
    font-weight: bold;
  `
  closeBtn.addEventListener('click', toggle)
  toolbar.appendChild(closeBtn)

  container.appendChild(toolbar)

  // Update functions
  function updatePerformancePanel() {
    if (!profiler || !state.panels.performance.visible) return
    const stats = profiler.state
    let html = `
    <div style="color: ${stats.fps > 55 ? '#0f0' : stats.fps > 30 ? '#ff0' : '#f00'}">
      <strong>FPS: ${stats.fps}</strong> (${stats.lastMs.toFixed(2)}ms)
    </div>
    <div style="margin-top: 4px; font-size: 10px;">
      Min/Avg/Max: ${stats.minMs}/${stats.avgMs}/${stats.maxMs}ms<br>
      CPU: ${stats.cpuMs}ms | GPU: ${stats.gpuMs.toFixed(2)}ms<br>
      Draw Calls: ${stats.drawCalls} | Triangles: ${(stats.triangles / 1000).toFixed(0)}K<br>
      Entities: ${stats.entityCount}<br>
      Memory: ${stats.memHeapMB}/${stats.memLimitMB}MB (${stats.memUsagePercent}%)<br>
      Textures: ${stats.textureMemMB}MB | Geometry: ${stats.geometryMemMB}MB<br>
      Thermal: ${(stats.thermalLevel * 100).toFixed(0)}% | Battery: ${stats.batteryPercent}%
    </div>
    `
    panels.performance.content.innerHTML = html

    // Update session stats
    const fps = parseFloat(stats.fps)
    sessionStats.peakFPS = Math.max(sessionStats.peakFPS, fps)
    sessionStats.minFPS = Math.min(sessionStats.minFPS, fps)
    sessionStats.avgFPS = (sessionStats.peakFPS + sessionStats.minFPS) / 2
    sessionStats.peakMemory = Math.max(sessionStats.peakMemory, parseFloat(stats.memHeapMB))
  }

  function updateNetworkPanel() {
    if (!networkInspector || !state.panels.network.visible) return
    const stats = networkInspector.stats
    let html = `
    <div style="color: #0f0;">
      <strong>Latency: ${stats.avgLatency.toFixed(1)}ms</strong>
    </div>
    <div style="margin-top: 4px; font-size: 10px;">
      Messages: ${stats.messageCount}<br>
    </div>
    <div style="margin-top: 8px; color: #0ff;">
      <strong>Message Types:</strong>
    </div>
    <div style="font-size: 9px; margin-top: 4px;">
    `
    stats.messageStats.forEach((stat, type) => {
      html += `${type}: ${stat.count} (${(stat.totalBytes / 1024).toFixed(1)}KB)<br>`
    })
    html += '</div>'
    panels.network.content.innerHTML = html
  }

  function updateDebugPanel() {
    if (!state.panels.debug.visible) return
    const navigator = window.navigator || {}
    const perf = window.performance || {}

    let html = `
    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; font-size: 10px;">
      <div><strong>Device</strong><br>
        ${navigator.userAgent?.split(' ').slice(-1)[0] || 'Unknown'}<br>
        ${navigator.hardwareConcurrency || '?'} cores<br>
        ${(navigator.deviceMemory || '?')}GB RAM
      </div>
      <div><strong>Rendering</strong><br>
        ${window.__renderer?.info?.render?.calls || 0} calls/frame<br>
        ${(window.__renderer?.getPixelRatio?.() || 1).toFixed(2)}x DPR<br>
        ${window.innerWidth}x${window.innerHeight}
      </div>
      <div><strong>Network</strong><br>
        ${navigator.connection?.effectiveType || 'unknown'}<br>
        ${navigator.connection?.rtt || '?'}ms RTT<br>
        ${navigator.connection?.downlink || '?'} Mbps
      </div>
    </div>
    `
    panels.debug.content.innerHTML = html
  }

  function setPreset(preset) {
    state.activePreset = preset
    const visibility = {
      all: { perf: true, net: true, debug: true },
      fps: { perf: true, net: false, debug: false },
      network: { perf: false, net: true, debug: false },
      memory: { perf: true, net: false, debug: false },
    }
    const v = visibility[preset] || visibility.all
    panels.performance.panel.style.display = v.perf ? 'flex' : 'none'
    panels.network.panel.style.display = v.net ? 'flex' : 'none'
    panels.debug.panel.style.display = v.debug ? 'flex' : 'none'
  }

  function exportSession(format = 'json') {
    const data = {
      timestamp: new Date().toISOString(),
      duration: (Date.now() - sessionStats.startTime) / 1000,
      session: sessionStats,
      profiler: profiler?.state,
      network: {
        avgLatency: networkInspector?.stats?.avgLatency,
        messageCount: networkInspector?.stats?.messageCount,
      },
    }

    if (format === 'json') {
      const json = JSON.stringify(data, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `dev-session-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  }

  function toggle() {
    state.enabled = !state.enabled
    container.style.display = state.enabled ? 'block' : 'none'
    toolbar.style.display = state.enabled ? 'flex' : 'none'
  }

  function update() {
    if (!state.enabled) return
    updatePerformancePanel()
    updateNetworkPanel()
    updateDebugPanel()
  }

  function install() {
    if (!document.body) return
    document.body.appendChild(container)
    document.body.appendChild(toolbar)
    container.style.display = 'none'
    toolbar.style.display = 'none'

    window.__devDashboard = {
      toggle,
      setPreset,
      exportSession,
      state: sessionStats,
    }
  }

  return { install, toggle, update, exportSession }
}
