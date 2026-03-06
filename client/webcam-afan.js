const ARKIT_NAMES = ['browInnerUp','browDownLeft','browDownRight','browOuterUpLeft','browOuterUpRight','eyeLookUpLeft','eyeLookUpRight','eyeLookDownLeft','eyeLookDownRight','eyeLookInLeft','eyeLookInRight','eyeLookOutLeft','eyeLookOutRight','eyeBlinkLeft','eyeBlinkRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight','cheekPuff','cheekSquintLeft','cheekSquintRight','noseSneerLeft','noseSneerRight','jawOpen','jawForward','jawLeft','jawRight','mouthFunnel','mouthPucker','mouthLeft','mouthRight','mouthRollUpper','mouthRollLower','mouthShrugUpper','mouthShrugLower','mouthOpen','mouthClose','mouthSmileLeft','mouthSmileRight','mouthFrownLeft','mouthFrownRight','mouthDimpleLeft','mouthDimpleRight','mouthUpperUpLeft','mouthUpperUpRight','mouthLowerDownLeft','mouthLowerDownRight','mouthPressLeft','mouthPressRight','mouthStretchLeft','mouthStretchRight']

function clamp(v) { return Math.max(0, Math.min(1, v)) }

function landmarksToBlendshapes(lm) {
  const dist = (a, b) => Math.sqrt((a.x-b.x)**2 + (a.y-b.y)**2 + (a.z-b.z)**2)
  const norm = dist(lm[234], lm[454]) || 1

  const EAR = (p1, p2, p3, p4, p5, p6) => {
    const w = dist(lm[p1], lm[p4])
    return w > 0 ? (dist(lm[p2], lm[p6]) + dist(lm[p3], lm[p5])) / (2 * w) : 0
  }

  const earLeft = EAR(33, 160, 158, 133, 153, 144)
  const earRight = EAR(362, 385, 387, 263, 373, 380)
  const eyeBlinkLeft = clamp(1 - earLeft / 0.28)
  const eyeBlinkRight = clamp(1 - earRight / 0.28)

  const jawOpen = clamp(dist(lm[13], lm[14]) / norm * 4)

  const lipSpread = dist(lm[61], lm[291]) / norm
  const smileRaw = clamp((lipSpread - 0.4) / 0.15)
  const mouthSmileLeft = smileRaw
  const mouthSmileRight = smileRaw

  const mouthFunnel = clamp((dist(lm[13], lm[14]) / norm - 0.05) * 5 * (1 - smileRaw))
  const mouthPucker = clamp((0.35 - lipSpread) / 0.15)

  const browLiftLeft = clamp((lm[159].y - lm[105].y) / norm * 6 - 0.2)
  const browLiftRight = clamp((lm[386].y - lm[334].y) / norm * 6 - 0.2)
  const browInnerUp = (browLiftLeft + browLiftRight) / 2
  const browOuterUpLeft = browLiftLeft
  const browOuterUpRight = browLiftRight
  const browDownLeft = clamp(0.3 - browLiftLeft)
  const browDownRight = clamp(0.3 - browLiftRight)

  const cheekWidth = dist(lm[117], lm[346]) / norm
  const cheekPuff = clamp((cheekWidth - 0.7) / 0.15)

  const noseSneerLeft = clamp(dist(lm[1], lm[129]) / norm * 3 - 0.5)
  const noseSneerRight = clamp(dist(lm[1], lm[358]) / norm * 3 - 0.5)

  const mouthLowerDown = clamp(jawOpen * 0.5)
  const mouthUpperUp = clamp(smileRaw * 0.3)

  return {
    browInnerUp, browDownLeft, browDownRight, browOuterUpLeft, browOuterUpRight,
    eyeLookUpLeft: 0, eyeLookUpRight: 0, eyeLookDownLeft: 0, eyeLookDownRight: 0,
    eyeLookInLeft: 0, eyeLookInRight: 0, eyeLookOutLeft: 0, eyeLookOutRight: 0,
    eyeBlinkLeft, eyeBlinkRight,
    eyeSquintLeft: clamp(eyeBlinkLeft * 0.3), eyeSquintRight: clamp(eyeBlinkRight * 0.3),
    eyeWideLeft: clamp((earLeft - 0.28) / 0.1), eyeWideRight: clamp((earRight - 0.28) / 0.1),
    cheekPuff, cheekSquintLeft: clamp(smileRaw * 0.4), cheekSquintRight: clamp(smileRaw * 0.4),
    noseSneerLeft, noseSneerRight,
    jawOpen, jawForward: 0, jawLeft: 0, jawRight: 0,
    mouthFunnel, mouthPucker, mouthLeft: 0, mouthRight: 0,
    mouthRollUpper: 0, mouthRollLower: 0, mouthShrugUpper: 0, mouthShrugLower: 0,
    mouthOpen: jawOpen, mouthClose: clamp(1 - jawOpen),
    mouthSmileLeft, mouthSmileRight,
    mouthFrownLeft: clamp(-smileRaw * 0.5 + 0.1), mouthFrownRight: clamp(-smileRaw * 0.5 + 0.1),
    mouthDimpleLeft: clamp(smileRaw * 0.2), mouthDimpleRight: clamp(smileRaw * 0.2),
    mouthUpperUpLeft: mouthUpperUp, mouthUpperUpRight: mouthUpperUp,
    mouthLowerDownLeft: mouthLowerDown, mouthLowerDownRight: mouthLowerDown,
    mouthPressLeft: 0, mouthPressRight: 0, mouthStretchLeft: 0, mouthStretchRight: 0
  }
}

function encodeBlendshapes(bs) {
  const buf = new Uint8Array(ARKIT_NAMES.length)
  for (let i = 0; i < ARKIT_NAMES.length; i++) buf[i] = Math.round((bs[ARKIT_NAMES[i]] || 0) * 255)
  return buf
}

export class WebcamAFANTracker {
  constructor() {
    this.stream = null
    this.video = null
    this.isTracking = false
    this.onAFANData = null
    this._faceMesh = null
    this._lastSend = 0
  }

  async init() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
      this.video = document.createElement('video')
      this.video.srcObject = this.stream
      this.video.playsInline = true
      await this.video.play()
      const loaded = await this._loadMediaPipe()
      if (!loaded) { console.warn('[WebcamAFAN] MediaPipe unavailable, using fallback'); this._startFallback(); return true }
      this.isTracking = true
      this._faceMesh.onResults((r) => this._onResults(r))
      this._runLoop()
      return true
    } catch (err) {
      console.error('[WebcamAFAN] init failed:', err.message)
      return false
    }
  }

  async _loadMediaPipe() {
    if (window.FaceMesh) {
      this._faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${f}` })
      this._faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 })
      await this._faceMesh.initialize()
      return true
    }
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/face_mesh.js'
        s.crossOrigin = 'anonymous'
        s.onload = resolve
        s.onerror = reject
        document.head.appendChild(s)
      })
      this._faceMesh = new window.FaceMesh({ locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4/${f}` })
      this._faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 })
      await this._faceMesh.initialize()
      return true
    } catch (e) {
      console.warn('[WebcamAFAN] MediaPipe load failed:', e.message)
      return false
    }
  }

  _onResults(results) {
    if (!this.isTracking) return
    const now = performance.now()
    if (now - this._lastSend < 33) return
    this._lastSend = now
    const lm = results.multiFaceLandmarks?.[0]
    if (!lm) return
    const bs = landmarksToBlendshapes(lm)
    if (this.onAFANData) this.onAFANData(encodeBlendshapes(bs))
  }

  _runLoop() {
    if (!this.isTracking || !this._faceMesh) return
    this._faceMesh.send({ image: this.video }).catch(() => {})
    setTimeout(() => this._runLoop(), 33)
  }

  _startFallback() {
    this.isTracking = true
    const loop = () => {
      if (!this.isTracking) return
      const bs = {}
      for (const n of ARKIT_NAMES) bs[n] = 0
      bs.jawOpen = Math.max(0, Math.sin(Date.now() / 800) * 0.3)
      bs.eyeBlinkLeft = Math.random() < 0.02 ? 0.9 : 0
      bs.eyeBlinkRight = bs.eyeBlinkLeft
      if (this.onAFANData) this.onAFANData(encodeBlendshapes(bs))
      setTimeout(loop, 33)
    }
    loop()
  }

  stop() {
    this.isTracking = false
    if (this._faceMesh) { this._faceMesh.close(); this._faceMesh = null }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null }
    if (this.video) { this.video.pause(); this.video.srcObject = null; this.video = null }
  }
}

window.enableWebcamAFAN = async (callback) => {
  const tracker = new WebcamAFANTracker()
  tracker.onAFANData = callback
  const ok = await tracker.init()
  return ok ? tracker : null
}
