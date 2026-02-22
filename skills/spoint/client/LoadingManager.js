export class LoadingManager extends EventTarget {
  static STAGES = {
    CONNECTING: { name: 'CONNECTING', label: 'Connecting...', range: [0, 10] },
    SERVER_SYNC: { name: 'SERVER_SYNC', label: 'Syncing with server...', range: [10, 20] },
    DOWNLOAD: { name: 'DOWNLOAD', label: 'Downloading player model...', range: [20, 50] },
    PROCESS: { name: 'PROCESS', label: 'Processing models...', range: [50, 65] },
    RESOURCES: { name: 'RESOURCES', label: 'Loading world resources...', range: [65, 85] },
    APPS: { name: 'APPS', label: 'Initializing apps...', range: [85, 95] },
    INIT: { name: 'INIT', label: 'Starting game...', range: [95, 100] },
    COMPLETE: { name: 'COMPLETE', label: 'Ready!', range: [100, 100] }
  }

  constructor() {
    super()
    this.currentStage = null
    this.currentPercent = 0
    this.lastPercent = 0
    this.stageProgress = new Map()
    this.isComplete = false
    this.startTime = Date.now()
    this.stageStartTime = {}
  }

  setStage(stageName) {
    const stage = LoadingManager.STAGES[stageName]
    if (!stage) return

    if (this.currentStage !== stageName) {
      this.stageStartTime[stageName] = Date.now()
      this.currentStage = stageName
      this.stageProgress.set(stageName, { current: 0, total: 1 })
      this._dispatch('stagechange', { stage: stageName, label: stage.label })
    }
  }

  updateProgress(current, total) {
    if (!this.currentStage) return
    this.stageProgress.set(this.currentStage, { current, total })
    const newPercent = this._calculatePercent()
    const clamped = this._clampPercent(newPercent)
    if (clamped !== this.currentPercent) {
      this.currentPercent = clamped
      const stage = LoadingManager.STAGES[this.currentStage]
      this._dispatch('progress', {
        stage: this.currentStage,
        label: stage.label,
        percent: clamped,
        current,
        total
      })
    }
  }

  _calculatePercent() {
    const stage = LoadingManager.STAGES[this.currentStage]
    if (!stage) return 0
    const [min, max] = stage.range
    const stageWidth = max - min
    const progress = this.stageProgress.get(this.currentStage)
    if (!progress || progress.total === 0) return min
    const stageFill = (progress.current / progress.total) * stageWidth
    return min + stageFill
  }

  _clampPercent(newPercent) {
    return Math.max(this.lastPercent, Math.min(100, newPercent))
  }

  complete() {
    this.setStage('COMPLETE')
    this.currentPercent = 100
    this.isComplete = true
    this._dispatch('progress', { stage: 'COMPLETE', label: 'Ready!', percent: 100 })
    this._dispatch('complete', {})
  }

  async fetchWithProgress(url) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
      const reader = response.body.getReader()
      const chunks = []
      let receivedLength = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        receivedLength += value.length
        if (contentLength > 0) {
          this.updateProgress(receivedLength, contentLength)
        }
      }

      const result = new Uint8Array(receivedLength)
      let position = 0
      for (const chunk of chunks) {
        result.set(chunk, position)
        position += chunk.length
      }
      return result
    } catch (error) {
      console.error('[loading] fetch failed:', url, error)
      throw error
    }
  }

  _dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  dispose() {
    this.stageProgress.clear()
    this.stageStartTime = {}
  }
}
