import * as THREE from 'three'

export class XRControls {
  constructor(options = {}) {
    this.enabled = false
    this.options = { placementMode: true, planeDetection: true, scale: 1, ...options }
    this.session = null; this.referenceSpace = null; this.hitTestSource = null
    this.planeDetected = false; this.anchorPlaced = false
    this.anchorPosition = new THREE.Vector3(); this.anchorRotation = new THREE.Quaternion()
    this.cameraPosition = new THREE.Vector3(); this.cameraQuaternion = new THREE.Quaternion()
    this.planes = new Map(); this.planeMeshes = []
    this.reticle = null; this.reticleVisible = false
  }

  createReticle() {
    const g = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2)
    this.reticle = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.7, transparent: true, side: THREE.DoubleSide }))
    this.reticle.visible = false; return this.reticle
  }

  createPlaneMesh() {
    return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x00ff88, opacity: 0.2, transparent: true, side: THREE.DoubleSide }))
  }

  async init(renderer) {
    if (!navigator.xr) { console.warn('[XR] WebXR not supported'); return false }
    if (!await navigator.xr.isSessionSupported('immersive-ar')) { console.warn('[XR] immersive-ar not supported'); return false }
    this.renderer = renderer; return true
  }

  async start() {
    if (!this.renderer) return false
    try {
      const init = { requiredFeatures: ['local-floor'], optionalFeatures: ['hit-test','plane-detection','anchors','dom-overlay'], domOverlay: { root: document.body } }
      this.session = await navigator.xr.requestSession('immersive-ar', init)
      this.renderer.xr.setSession(this.session); this.renderer.xr.setReferenceSpaceType('local-floor')
      this.referenceSpace = await this.session.requestReferenceSpace('local-floor')
      const viewer = await this.session.requestReferenceSpace('viewer')
      if (this.session.enabledFeatures?.includes('hit-test')) this.hitTestSource = await this.session.requestHitTestSource({ space: viewer })
      this.session.addEventListener('end', () => this.onSessionEnd())
      this.session.addEventListener('planesdetected', e => this.onPlanesDetected(e))
      this.enabled = true; return true
    } catch (err) { console.error('[XR] Failed to start session:', err); return false }
  }

  async end() { if (this.session) await this.session.end() }

  onSessionEnd() { this.enabled=false; this.session=null; this.hitTestSource=null; this.planeDetected=false; this.anchorPlaced=false }

  onPlanesDetected(e) {
    if (!this.options.planeDetection) return
    for (const p of e.detectedPlanes) { if (!this.planes.has(p)) { const m=this.createPlaneMesh(); m.userData.plane=p; this.planes.set(p,m); this.planeMeshes.push(m) } }
    this.planeDetected = true
  }

  showReticle(transform) {
    if (!this.reticle) return
    const m = new THREE.Matrix4().fromArray(transform.matrix)
    this.reticle.position.setFromMatrixPosition(m); this.reticle.quaternion.setFromRotationMatrix(m)
    this.reticle.visible = true; this.reticleVisible = true
  }

  hideReticle() { if (this.reticle) { this.reticle.visible=false; this.reticleVisible=false } }

  placeAnchor() {
    if (!this.reticleVisible) return false
    this.anchorPosition.copy(this.reticle.position); this.anchorRotation.copy(this.reticle.quaternion)
    this.anchorPlaced = true; this.hideReticle(); return true
  }

  placeAtCamera() {
    this.anchorPosition.copy(this.cameraPosition); this.anchorRotation.copy(this.cameraQuaternion)
    this.anchorPlaced = true; this.hideReticle(); return true
  }

  setInitialFPSPosition(fpsPos, fpsYaw) {
    this.anchorPosition.set(this.cameraPosition.x, this.cameraPosition.y-fpsPos[1]-1.6, this.cameraPosition.z)
    const q = new THREE.Quaternion(); q.setFromAxisAngle(new THREE.Vector3(0,1,0), fpsYaw!==undefined?-fpsYaw:0)
    this.anchorRotation.copy(q); this.anchorPlaced=true; this.hideReticle(); return true
  }

  updateSceneTransform(root) {
    if (!root||!this.anchorPlaced) return
    root.position.set(-this.anchorPosition.x,-this.anchorPosition.y,-this.anchorPosition.z); root.updateMatrixWorld(true)
  }

  update(frame, camera, root) {
    if (!this.enabled||!frame) return
    const pose = frame.getViewerPose(this.referenceSpace); if (!pose) return
    const vm = new THREE.Matrix4().fromArray(pose.views[0].transform.matrix)
    vm.decompose(this.cameraPosition, this.cameraQuaternion, new THREE.Vector3())
    if (!this.anchorPlaced && this.hitTestSource && this.options.placementMode) {
      const res = frame.getHitTestResults(this.hitTestSource)
      if (res.length > 0) { const p = res[0].getPose(this.referenceSpace); if (p) this.showReticle(p.transform) }
    }
    if (this.anchorPlaced && root) this.updateSceneTransform(root)
  }

  getPlacementInfo() { return { placed: this.anchorPlaced, position: this.anchorPosition.toArray(), rotation: this.anchorRotation.toArray(), planeDetected: this.planeDetected } }

  dispose() {
    this.end(); this.planes.clear(); this.planeMeshes = []
    if (this.reticle) { this.reticle.geometry.dispose(); this.reticle.material.dispose(); this.reticle=null }
  }
}

export async function createXRButton(renderer, onStart, onEnd) {
  if (!navigator.xr || !await navigator.xr.isSessionSupported('immersive-ar')) return null
  const btn = document.createElement('button')
  btn.id = 'ar-button'; btn.textContent = 'Enter XR'
  btn.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);padding:12px 24px;background:rgba(0,150,0,0.8);color:white;border:none;border-radius:8px;font-size:16px;font-weight:bold;cursor:pointer;z-index:1001;touch-action:none'
  btn.addEventListener('click', async () => {
    const ok = await onStart?.(); if (!ok) return
    btn.textContent = 'Exit XR'; btn.style.background = 'rgba(150,0,0,0.8)'
    if (onEnd) btn.onclick = onEnd
  })
  return btn
}
