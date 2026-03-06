import * as THREE from 'three'

// Lazy-loaded WebCam AFAN stream tracker
// Inspired by: https://threejs.org/examples/?q=webcam#webgl_morphtargets_webcam
// and https://github.com/AnEntrypoint/audio2afan

export class WebcamAFANTracker {
    constructor() {
        this.stream = null
        this.video = null
        this.isTracking = false
        this.onAFANData = null
    }

    async init() {
        console.log('[WebcamAFAN] Initializing webcam tracking...')
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })

            this.video = document.createElement('video')
            this.video.srcObject = this.stream
            this.video.play()

            // Here we would initialize MediaPipe or audio2afan ML model
            // For this implementation, we will mock the afan generation loop
            // which should be fully integrated with AnEntrypoint/audio2afan

            this.isTracking = true
            this._updateLoop()

            return true
        } catch (err) {
            console.error('[WebcamAFAN] Failed to init webcam:', err)
            return false
        }
    }

    _updateLoop() {
        if (!this.isTracking) return

        // Simulate generating AFAN (Audio-driven facial animation) binary stream
        // In a real scenario, this would involve processing audio/video data
        const mockAFANData = new Uint8Array([0x01, 0x02, 0x03, Math.floor(Math.random() * 255)])

        if (this.onAFANData) {
            this.onAFANData(mockAFANData)
        }

        requestAnimationFrame(this._updateLoop.bind(this))
    }

    stop() {
        this.isTracking = false
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop())
            this.stream = null
        }
        if (this.video) {
            this.video.pause()
            this.video.removeAttribute('src')
            this.video.load()
            this.video = null
        }
        console.log('[WebcamAFAN] Stopped')
    }
}

// Global hook to instantiate
window.enableWebcamAFAN = async (callback) => {
    const tracker = new WebcamAFANTracker()
    tracker.onAFANData = callback
    await tracker.init()
    return tracker
}
