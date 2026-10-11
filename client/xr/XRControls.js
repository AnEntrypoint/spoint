import * as THREE from 'three'
import { isXRSessionSupported } from './xrSessionSupport.js'

export class XRControls {
  constructor(options = {}) {
    this.enabled = false
    this.options = { placementMode: true, ...options }
    this.session = null; this.referenceSpace = null; this.hitTestSource = null
    this.cameraPosition = new THREE.Vector3(); this.cameraQuaternion = new THREE.Quaternion()
    this.reticle = null
  }

  onSessionChange = null

  get enabled() { return this._sessionActive === true }

  set enabled(active) {
    if (this._sessionActive === active) return
    this._sessionActive = active
    this.onSessionChange?.(active)
  }

  createReticle() {
    const g = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2)
    this.reticle = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.7, transparent: true, side: THREE.DoubleSide }))
    this.reticle.visible = false; return this.reticle
  }

  async init(renderer) {
    if (!navigator.xr) { console.warn('[XR] WebXR not supported'); return false }
    if (!await isXRSessionSupported('immersive-ar')) { console.warn('[XR] immersive-ar not supported'); return false }
    this.renderer = renderer; return true
  }

  async start() {
    if (!this.renderer) return false
    try {
      const init = { requiredFeatures: ['local-floor'], optionalFeatures: ['hit-test','anchors','dom-overlay'], domOverlay: { root: document.body } }
      this.session = await navigator.xr.requestSession('immersive-ar', init)
      this.renderer.xr.setSession(this.session); this.renderer.xr.setReferenceSpaceType('local-floor')
      this.referenceSpace = await this.session.requestReferenceSpace('local-floor')
      const viewer = await this.session.requestReferenceSpace('viewer')
      if (this.session.enabledFeatures?.includes('hit-test')) this.hitTestSource = await this.session.requestHitTestSource({ space: viewer })
      this.session.addEventListener('end', () => this.onSessionEnd())
      this.enabled = true; return true
    } catch (err) { console.error('[XR] Failed to start session:', err); await this.end(); this.onSessionEnd(); return false }
  }

  async end() { if (this.session) await this.session.end() }

  onSessionEnd() { this.enabled=false; this.session=null; this.hitTestSource=null }

  showReticle(transform) {
    if (!this.reticle) return
    const m = new THREE.Matrix4().fromArray(transform.matrix)
    this.reticle.position.setFromMatrixPosition(m); this.reticle.quaternion.setFromRotationMatrix(m)
    this.reticle.visible = true
  }

  update(frame) {
    if (!this.enabled||!frame) return
    const pose = frame.getViewerPose(this.referenceSpace); if (!pose) return
    const vm = new THREE.Matrix4().fromArray(pose.views[0].transform.matrix)
    vm.decompose(this.cameraPosition, this.cameraQuaternion, new THREE.Vector3())
    if (this.hitTestSource && this.options.placementMode) {
      const res = frame.getHitTestResults(this.hitTestSource)
      if (res.length > 0) { const p = res[0].getPose(this.referenceSpace); if (p) this.showReticle(p.transform) }
    }
  }
}

function ensureXRStyle() {
  if (document.getElementById('xr-controls-style')) return
  const s = document.createElement('style')
  s.id = 'xr-controls-style'
  s.textContent = `
    #ar-button.xr-btn{position:fixed;left:50%;transform:translateX(-50%);bottom:max(20px,env(safe-area-inset-bottom));z-index:1001;font-size:16px;font-weight:600;padding:12px 24px;cursor:pointer;touch-action:none;min-height:44px;min-width:44px}
    #ar-button.xr-btn.xr-exit{background:var(--danger, color-mix(in oklab, var(--accent) 70%, #000));color:var(--accent-fg, var(--panel-text));border-color:var(--danger, var(--accent))}
  `
  document.head.appendChild(s)
}

export async function createXRButton(renderer, onStart, onEnd) {
  if (!await isXRSessionSupported('immersive-ar')) return null
  ensureXRStyle()
  const btn = document.createElement('button')
  btn.id = 'ar-button'
  btn.className = 'btn btn-primary ds-247420 xr-btn'
  btn.textContent = 'Enter XR'
  btn.addEventListener('click', async () => {
    const ok = await onStart?.(); if (!ok) return
    btn.textContent = 'Exit XR'
    btn.classList.remove('btn-primary')
    btn.classList.add('xr-exit')
    if (onEnd) btn.onclick = onEnd
  })
  return btn
}
