export function createLoadingScreen(loadingManager) {
  const overlay = document.createElement('div')
  overlay.id = 'loading-overlay'
  overlay.className = 'loading-overlay'
  overlay.innerHTML = `
    <div class="loading-container">
      <div class="loading-header">
        <h1>Spawnpoint</h1>
        <p class="loading-label">Connecting...</p>
      </div>
      <div class="loading-bars">
        <div class="loading-bar-row">
          <span class="loading-bar-name">Download</span>
          <div class="loading-bar-track">
            <div class="loading-bar-fill loading-bar-download"></div>
          </div>
          <span class="loading-bar-pct dl-pct">0%</span>
        </div>
        <div class="loading-bar-row">
          <span class="loading-bar-name">Processing</span>
          <div class="loading-bar-track">
            <div class="loading-bar-fill loading-bar-process"></div>
          </div>
          <span class="loading-bar-pct proc-pct">0%</span>
        </div>
      </div>
      <div class="loading-detail-text"></div>
      <div class="loading-spinner">
        <div class="spinner-dot"></div>
        <div class="spinner-dot"></div>
        <div class="spinner-dot"></div>
      </div>
    </div>
  `
  document.body.insertBefore(overlay, document.body.firstChild)

  const labelEl = overlay.querySelector('.loading-label')
  const dlFill = overlay.querySelector('.loading-bar-download')
  const procFill = overlay.querySelector('.loading-bar-process')
  const dlPct = overlay.querySelector('.dl-pct')
  const procPct = overlay.querySelector('.proc-pct')
  const detailEl = overlay.querySelector('.loading-detail-text')

  loadingManager.addEventListener('download', (e) => {
    const { percent, done, total } = e.detail
    dlFill.style.width = percent + '%'
    dlPct.textContent = Math.round(percent) + '%'
    if (total > 0) detailEl.textContent = `${done} / ${total} assets`
  })

  loadingManager.addEventListener('processing', (e) => {
    const { percent, done, total } = e.detail
    procFill.style.width = percent + '%'
    procPct.textContent = Math.round(percent) + '%'
    if (total > 0) detailEl.textContent = `Compiling shaders ${done} / ${total}`
  })

  loadingManager.addEventListener('label', (e) => {
    labelEl.textContent = e.detail.label
  })

  return {
    element: overlay,
    setLabel: (text) => { labelEl.textContent = text },
    hide: async () => {
      overlay.classList.add('fade-out')
      await new Promise(resolve => setTimeout(resolve, 500))
      overlay.remove()
    },
    dispose: () => { overlay.remove() }
  }
}
