export function createLoadingScreen(loadingManager) {
  const overlay = document.createElement('div')
  overlay.id = 'loading-overlay'
  overlay.className = 'loading-overlay'
  overlay.innerHTML = `
    <div class="loading-container">
      <div class="loading-header">
        <h1>Spawnpoint</h1>
        <p class="loading-stage-text">Connecting...</p>
      </div>
      <div class="loading-progress-wrapper">
        <div class="loading-progress-bar">
          <div class="loading-progress-fill"></div>
        </div>
        <div class="loading-percent">0%</div>
      </div>
      <div class="loading-details">
        <span class="loading-current">0</span> / <span class="loading-total">0</span> bytes
      </div>
      <div class="loading-spinner">
        <div class="spinner-dot"></div>
        <div class="spinner-dot"></div>
        <div class="spinner-dot"></div>
      </div>
    </div>
  `
  document.body.insertBefore(overlay, document.body.firstChild)

  const progressFill = overlay.querySelector('.loading-progress-fill')
  const percentText = overlay.querySelector('.loading-percent')
  const stageText = overlay.querySelector('.loading-stage-text')
  const currentBytes = overlay.querySelector('.loading-current')
  const totalBytes = overlay.querySelector('.loading-total')

  const updateUI = (detail) => {
    const percent = detail.percent || 0
    progressFill.style.width = percent + '%'
    percentText.textContent = Math.round(percent) + '%'
    stageText.textContent = detail.label || ''

    if (detail.current !== undefined && detail.total !== undefined) {
      currentBytes.textContent = formatBytes(detail.current)
      totalBytes.textContent = formatBytes(detail.total)
    }
  }

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0'
    const k = 1024
    const sizes = ['B', 'KB', 'MB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 10) / 10 + sizes[i]
  }

  loadingManager.addEventListener('progress', (e) => updateUI(e.detail))
  loadingManager.addEventListener('stagechange', (e) => updateUI(e.detail))

  return {
    element: overlay,
    hide: async () => {
      overlay.classList.add('fade-out')
      await new Promise(resolve => setTimeout(resolve, 500))
      overlay.remove()
    },
    dispose: () => {
      overlay.remove()
    }
  }
}
