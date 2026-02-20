import * as THREE from 'three'

export class ARControls {
  constructor(options = {}) {
    this.enabled = false
    this.options = {
      placementMode: true,
      planeDetection: true,
      scale: 1,
      ...options
    }

    this.session = null
    this.referenceSpace = null
    this.hitTestSource = null
    this.planeDetected = false
    this.anchorPlaced = false
    this.anchorPosition = new THREE.Vector3()
    this.anchorRotation = new THREE.Quaternion()
    this.cameraPosition = new THREE.Vector3()
    this.cameraQuaternion = new THREE.Quaternion()
    this.localOrigin = new THREE.Vector3()
    this.offsetTransform = null

    this.planes = new Map()
    this.planeMeshes = []

    this.reticle = null
    this.reticleVisible = false
  }

  createReticle() {
    const geometry = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2)
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      opacity: 0.7,
      transparent: true,
      side: THREE.DoubleSide
    })
    this.reticle = new THREE.Mesh(geometry, material)
    this.reticle.visible = false
    return this.reticle
  }

  createPlaneMesh(plane) {
    const geometry = new THREE.PlaneGeometry(1, 1)
    const material = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      opacity: 0.2,
      transparent: true,
      side: THREE.DoubleSide
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.userData.plane = plane
    return mesh
  }

  async init(renderer) {
    if (!navigator.xr) {
      console.warn('[AR] WebXR not supported')
      return false
    }

    const isSupported = await navigator.xr.isSessionSupported('immersive-ar')
    if (!isSupported) {
      console.warn('[AR] immersive-ar not supported')
      return false
    }

    this.renderer = renderer
    return true
  }

  async start() {
    if (!this.renderer) return false

    try {
      const sessionInit = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hit-test', 'plane-detection', 'anchors', 'dom-overlay'],
        domOverlay: { root: document.body }
      }

      this.session = await navigator.xr.requestSession('immersive-ar', sessionInit)
      this.renderer.xr.setSession(this.session)
      this.renderer.xr.setReferenceSpaceType('local-floor')

      this.referenceSpace = await this.session.requestReferenceSpace('local-floor')
      const viewerSpace = await this.session.requestReferenceSpace('viewer')

      if (this.session.enabledFeatures?.includes('hit-test')) {
        this.hitTestSource = await this.session.requestHitTestSource({ space: viewerSpace })
      }

      this.session.addEventListener('end', () => this.onSessionEnd())
      this.session.addEventListener('planesdetected', (e) => this.onPlanesDetected(e))

      this.enabled = true
      console.log('[AR] Session started')
      return true
    } catch (err) {
      console.error('[AR] Failed to start session:', err)
      return false
    }
  }

  async end() {
    if (this.session) {
      await this.session.end()
    }
  }

  onSessionEnd() {
    this.enabled = false
    this.session = null
    this.hitTestSource = null
    this.planeDetected = false
    this.anchorPlaced = false
    console.log('[AR] Session ended')
  }

  onPlanesDetected(event) {
    if (!this.options.planeDetection) return

    for (const plane of event.detectedPlanes) {
      if (!this.planes.has(plane)) {
        const mesh = this.createPlaneMesh(plane)
        this.planes.set(plane, mesh)
        this.planeMeshes.push(mesh)
      }
    }
    this.planeDetected = true
  }

  update(frame, camera, sceneRoot) {
    if (!this.enabled || !frame) return

    const pose = frame.getViewerPose(this.referenceSpace)
    if (!pose) return

    const view = pose.views[0]
    const viewMatrix = new THREE.Matrix4().fromArray(view.transform.matrix)
    viewMatrix.decompose(this.cameraPosition, this.cameraQuaternion, new THREE.Vector3())

    if (!this.anchorPlaced && this.hitTestSource && this.options.placementMode) {
      const results = frame.getHitTestResults(this.hitTestSource)
      if (results.length > 0) {
        const hit = results[0]
        const pose = hit.getPose(this.referenceSpace)
        if (pose) {
          this.showReticle(pose.transform)
        }
      }
    }

    if (this.anchorPlaced && sceneRoot) {
      this.updateSceneTransform(sceneRoot)
    }
  }

  showReticle(transform) {
    if (!this.reticle) return
    this.reticle.position.setFromMatrixPosition(new THREE.Matrix4().fromArray(transform.matrix))
    this.reticle.quaternion.setFromRotationMatrix(new THREE.Matrix4().fromArray(transform.matrix))
    this.reticle.visible = true
    this.reticleVisible = true
  }

  hideReticle() {
    if (this.reticle) {
      this.reticle.visible = false
      this.reticleVisible = false
    }
  }

  placeAnchor() {
    if (!this.reticleVisible) return false

    this.anchorPosition.copy(this.reticle.position)
    this.anchorRotation.copy(this.reticle.quaternion)
    this.anchorPlaced = true
    this.hideReticle()
    console.log('[AR] Anchor placed at:', this.anchorPosition)
    return true
  }

  updateSceneTransform(sceneRoot) {
    if (!sceneRoot || !this.anchorPlaced) return

    sceneRoot.position.set(
      -this.anchorPosition.x,
      -this.anchorPosition.y,
      -this.anchorPosition.z
    )
    sceneRoot.updateMatrixWorld(true)
  }

  placeAtCamera() {
    this.anchorPosition.copy(this.cameraPosition)
    this.anchorRotation.copy(this.cameraQuaternion)
    this.anchorPlaced = true
    this.hideReticle()
    console.log('[AR] Anchor placed at camera:', this.anchorPosition)
    return true
  }

  localizeAroundFPS(fpsPosition, fpsYaw, fpsPitch) {
    if (!this.anchorPlaced) return

    const offset = new THREE.Vector3()
    offset.x = -fpsPosition[0]
    offset.y = -fpsPosition[1] - 1.6
    offset.z = -fpsPosition[2]

    const yawQuat = new THREE.Quaternion()
    yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), fpsYaw)

    this.anchorPosition.copy(offset)
    this.anchorRotation.copy(yawQuat)
  }

  setInitialFPSPosition(fpsPosition, fpsYaw) {
    const offset = new THREE.Vector3()
    offset.x = this.cameraPosition.x
    offset.y = this.cameraPosition.y - fpsPosition[1] - 1.6
    offset.z = this.cameraPosition.z

    const invYaw = fpsYaw !== undefined ? -fpsYaw : 0
    const yawQuat = new THREE.Quaternion()
    yawQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), invYaw)

    this.anchorPosition.copy(offset)
    this.anchorRotation.copy(yawQuat)
    this.anchorPlaced = true
    this.hideReticle()
    console.log('[AR] Set initial FPS position:', this.anchorPosition)
    return true
  }

  getPlacementInfo() {
    return {
      placed: this.anchorPlaced,
      position: this.anchorPosition.toArray(),
      rotation: this.anchorRotation.toArray(),
      planeDetected: this.planeDetected
    }
  }

  dispose() {
    this.end()
    this.planes.clear()
    this.planeMeshes = []
    if (this.reticle) {
      this.reticle.geometry.dispose()
      this.reticle.material.dispose()
      this.reticle = null
    }
  }
}

export async function createARButton(renderer, onStart, onEnd) {
  if (!navigator.xr) return null

  const isSupported = await navigator.xr.isSessionSupported('immersive-ar')
  if (!isSupported) return null

  const button = document.createElement('button')
  button.id = 'ar-button'
  button.textContent = 'Enter XR'
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    background: rgba(0, 150, 0, 0.8);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
    z-index: 1001;
    touch-action: none;
  `

  button.addEventListener('click', async () => {
    if (onStart) {
      const started = await onStart()
      if (started) {
        button.textContent = 'Exit AR'
        button.style.background = 'rgba(150, 0, 0, 0.8)'
        if (onEnd) {
          button.onclick = onEnd
        }
      }
    }
  })

  return button
}