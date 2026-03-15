import * as THREE from 'three'

const FADE_SPEED = 5
const FADE_DELAY = 50
const ARC_SEGMENTS = 20
const ARC_GRAVITY = -9.8
const ARC_VELOCITY = 8

export function createXRWidgets(renderer, scene, camera, vrSettings) {
  let wristUI = null, wristUICanvas = null, wristUIContext = null
  let vrSettingsPanel = null
  let teleportArc = null, teleportMarker = null, isTeleporting = false
  let fadeQuad = null, fadeOpacity = 0, fadeState = 'none'
  let vignetteMesh = null, vignetteOpacity = 0, vignetteTargetOpacity = 0
  let handsDetected = false
  const _tmp1 = new THREE.Vector3(), _tmp2 = new THREE.Vector3()

  function createWristUI() {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.06), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.9, side: THREE.DoubleSide }))
    mesh.name = 'wristUI'; return { mesh, canvas, ctx, texture }
  }

  function initWristUI(hand) {
    wristUI = createWristUI(); wristUICanvas = wristUI.canvas; wristUIContext = wristUI.ctx
    wristUI.mesh.position.set(0, -0.05, 0.08); wristUI.mesh.rotation.x = -Math.PI / 3; hand.add(wristUI.mesh)
  }

  function updateWristUI(health, ammo, reloading) {
    if (!wristUIContext) return
    const ctx = wristUIContext, canvas = wristUICanvas
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, canvas.width, canvas.height)
    ctx.font = 'bold 36px monospace'; ctx.textAlign = 'left'
    ctx.fillStyle = health > 60 ? '#00ff00' : health > 30 ? '#ffff00' : '#ff0000'
    ctx.fillText(`HP ${Math.round(health)}`, 10, 45)
    ctx.textAlign = 'right'; ctx.fillStyle = reloading ? '#ffff00' : '#00ffff'
    ctx.fillText(reloading ? 'RELOAD' : `${ammo}/30`, 246, 45)
    ctx.font = '24px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'
    ctx.fillText('SPAWNPOINT VR', 128, 100)
    wristUI.texture.needsUpdate = true
  }

  function createSettingsPanel() {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.95, side: THREE.DoubleSide }))
    mesh.name = 'vrSettingsPanel'; mesh.visible = false; mesh.position.set(0, 0, -0.6)
    return { mesh, canvas, ctx, texture, visible: false }
  }

  function updateSettingsPanel() {
    if (!vrSettingsPanel) return
    const ctx = vrSettingsPanel.ctx, canvas = vrSettingsPanel.canvas
    ctx.fillStyle = 'rgba(20,20,40,0.95)'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 4; ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
    ctx.font = 'bold 32px sans-serif'; ctx.fillStyle = '#00ffff'; ctx.textAlign = 'center'; ctx.fillText('VR SETTINGS', 256, 50)
    ctx.font = '24px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'
    ctx.fillText(`Snap Turn: ${vrSettings.snapTurnAngle}°`, 40, 120); ctx.fillText('[B/Y] to cycle', 280, 120)
    ctx.fillText(`Smooth Turn: ${vrSettings.smoothTurnSpeed === 0 ? 'OFF' : vrSettings.smoothTurnSpeed.toFixed(1)}`, 40, 180); ctx.fillText('[X/A] to cycle', 280, 180)
    ctx.fillText(`Vignette: ${vrSettings.vignetteEnabled ? 'ON' : 'OFF'}`, 40, 240); ctx.fillText('[Grip] to toggle', 280, 240)
    ctx.fillText(`Height: ${vrSettings.playerHeight.toFixed(2)}m`, 40, 300); ctx.fillText('[Menu] adjust', 280, 300)
    ctx.fillStyle = vrSettings.teleportEnabled ? '#00ff00' : '#ff0000'
    ctx.fillText(`Teleport: ${vrSettings.teleportEnabled ? 'ON' : 'OFF'}`, 40, 360)
    ctx.fillStyle = '#ffffff'; ctx.fillText('[Trigger] toggle', 280, 360)
    ctx.fillStyle = '#888888'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Press [Menu] button to close', 256, 480)
    vrSettingsPanel.texture.needsUpdate = true
  }

  function toggleSettings() {
    if (!vrSettingsPanel) { vrSettingsPanel = createSettingsPanel(); camera.add(vrSettingsPanel.mesh) }
    vrSettingsPanel.visible = !vrSettingsPanel.visible; vrSettingsPanel.mesh.visible = vrSettingsPanel.visible
    if (vrSettingsPanel.visible) updateSettingsPanel()
  }

  function initTeleport() {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_SEGMENTS * 3), 3))
    teleportArc = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.6 }))
    teleportArc.name = 'teleportArc'; teleportArc.visible = false; scene.add(teleportArc)
    teleportMarker = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 32), new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }))
    teleportMarker.name = 'teleportMarker'; teleportMarker.rotation.x = -Math.PI / 2; teleportMarker.visible = false; scene.add(teleportMarker)
  }

  function executeTeleport(pt, xrBase) {
    isTeleporting = true; fadeState = 'in'
    setTimeout(() => {
      const base = xrBase || renderer.xr.getReferenceSpace()
      if (!base) { isTeleporting = false; fadeState = 'out'; return }
      renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(new XRRigidTransform({ x: -pt.x, y: -pt.y, z: -pt.z }, { x: 0, y: 0, z: 0, w: 1 })))
    }, 200)
    setTimeout(() => { isTeleporting = false }, 400)
  }

  function computeParabolicArc(origin, direction) {
    const positions = teleportArc.geometry.attributes.position.array; let idx = 0, hit = null
    for (let i = 0; i < ARC_SEGMENTS; i++) {
      const t = i * 0.05
      const x = origin.x + direction.x * ARC_VELOCITY * t
      const y = origin.y + direction.y * ARC_VELOCITY * t + 0.5 * ARC_GRAVITY * t * t
      const z = origin.z + direction.z * ARC_VELOCITY * t
      if (idx < positions.length) { positions[idx++] = x; positions[idx++] = y; positions[idx++] = z }
      if (!hit && y < 0.1) {
        const pt = (i - 1) * 0.05, py = origin.y + direction.y * ARC_VELOCITY * pt + 0.5 * ARC_GRAVITY * pt * pt
        if (py > 0.1) { const f = (0.1 - py) / (y - py), ht = pt + f * 0.05; hit = { point: new THREE.Vector3(origin.x + direction.x * ARC_VELOCITY * ht, 0, origin.z + direction.z * ARC_VELOCITY * ht), valid: true } }
      }
    }
    teleportArc.geometry.attributes.position.needsUpdate = true; teleportArc.visible = true; return hit
  }

  function updateTeleportArc(handsDetectedNow, handModels, xrBase) {
    handsDetected = handsDetectedNow
    if (!renderer.xr.isPresenting || !teleportArc || !vrSettings.teleportEnabled) { if (teleportArc) teleportArc.visible = false; if (teleportMarker) teleportMarker.visible = false; return }
    const session = renderer.xr.getSession(); if (!session) return
    let origin = null, direction = null, triggerTeleport = false
    if (handsDetected) {
      const lh = handModels?.get(0)
      if (lh) {
        const j = lh.hand.joints
        if (j?.['index-finger-tip']) {
          j['index-finger-tip'].getWorldPosition(_tmp1); j['index-finger-tip'].getWorldDirection(_tmp2)
          origin = _tmp1.clone(); direction = _tmp2.clone().multiplyScalar(-1)
          const thumbTip = j['thumb-tip'], indexTip = j['index-finger-tip']
          if (thumbTip && indexTip) triggerTeleport = thumbTip.position.distanceTo(indexTip.position) < 0.02
        }
      }
    } else {
      for (const s of session.inputSources) {
        if (s.handedness === 'left' && s.gamepad) {
          const lc = renderer.xr.getController(0); lc.getWorldPosition(_tmp1); lc.getWorldDirection(_tmp2).multiplyScalar(-1); origin = _tmp1.clone(); direction = _tmp2.clone()
        }
        if (s.handedness === 'right' && s.gamepad?.buttons[1]?.pressed) triggerTeleport = true
      }
    }
    if (!origin || !direction) { teleportArc.visible = false; teleportMarker.visible = false; return }
    const hit = computeParabolicArc(origin, direction)
    if (hit?.valid) { teleportMarker.position.set(hit.point.x, hit.point.y + 0.02, hit.point.z); teleportMarker.material.color.setHex(0x00ff00); teleportMarker.visible = true; if (triggerTeleport && !isTeleporting) executeTeleport(hit.point, xrBase) }
    else { teleportMarker.visible = false }
  }

  function updateFade(dt) {
    if (!fadeQuad) { const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false })); q.renderOrder = 9999; fadeQuad = q; camera.add(fadeQuad); fadeQuad.position.z = -0.1 }
    if (fadeState === 'in') { fadeOpacity += FADE_SPEED * dt; if (fadeOpacity >= 1) { fadeOpacity = 1; fadeState = 'delay'; setTimeout(() => { fadeState = 'out' }, FADE_DELAY) } }
    else if (fadeState === 'out') { fadeOpacity -= FADE_SPEED * dt; if (fadeOpacity <= 0) { fadeOpacity = 0; fadeState = 'none' } }
    fadeQuad.material.opacity = fadeOpacity; fadeQuad.visible = fadeOpacity > 0.01
  }

  function updateVignette(dt, isMoving) {
    if (!vrSettings.vignetteEnabled) { if (vignetteMesh) vignetteMesh.visible = false; return }
    if (!vignetteMesh) {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
      const ctx = canvas.getContext('2d'), g = ctx.createRadialGradient(256, 256, 100, 256, 256, 400)
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0.8)')
      ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512)
      vignetteMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0, depthTest: false, depthWrite: false }))
      vignetteMesh.renderOrder = 9998; camera.add(vignetteMesh); vignetteMesh.position.z = -0.15
    }
    vignetteTargetOpacity = isMoving ? 0.6 : 0
    vignetteOpacity += (vignetteTargetOpacity - vignetteOpacity) * 5 * dt
    vignetteMesh.material.opacity = vignetteOpacity; vignetteMesh.visible = vignetteOpacity > 0.01
  }

  return { initWristUI, updateWristUI, toggleSettings, updateSettingsPanel, initTeleport, updateTeleportArc, updateFade, updateVignette, get isTeleporting() { return isTeleporting }, get settingsVisible() { return vrSettingsPanel?.visible || false } }
}
