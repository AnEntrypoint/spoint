import * as THREE from 'three'
import { createMachine, createActor } from '/node_modules/xstate/dist/xstate.esm.js'
import { createRayLine } from './XRRayLine.js'

const FADE_SPEED = 5
const FADE_DELAY_S = 0.05
const ARC_SEGMENTS = 20
const ARC_GRAVITY = -9.8
const ARC_VELOCITY = 8
const TELEPORT_MOVE_MS = 200
const TELEPORT_SETTLE_MS = 200

const fadeMachine = createMachine({
  id: 'fade',
  initial: 'idle',
  states: {
    idle: { on: { START: 'fadeIn' } },
    fadeIn: { on: { FULL: 'delay' } },
    delay: { on: { RESUME: 'fadeOut' } },
    fadeOut: { on: { DONE: 'idle' } }
  }
})

export function createXRWidgets(scene, camera, initialSettings, moveXROrigin) {
  let settings = { ...initialSettings }
  let wristUI = null
  let vrSettingsPanel = null
  let teleportArc = null, teleportMarker = null, teleportPending = null, teleportTimer = 0
  let fadeQuad = null, fadeOpacity = 0, fadeDelayElapsed = 0
  const _fadeActor = createActor(fadeMachine); _fadeActor.start()
  let vignetteMesh = null, vignetteOpacity = 0, vignetteTargetOpacity = 0

  function createScreenQuad({ renderOrder, z, material }) {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    quad.renderOrder = renderOrder; quad.position.z = z; camera.add(quad)
    return quad
  }

  function setQuadOpacity(quad, opacity) {
    quad.material.opacity = opacity; quad.visible = opacity > 0.01
  }

  function createWristUI() {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128
    const ctx = canvas.getContext('2d')
    const texture = new THREE.CanvasTexture(canvas)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.06), new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.9, side: THREE.DoubleSide }))
    mesh.name = 'wristUI'; return { mesh, canvas, ctx, texture }
  }

  function initWristUI(hand) {
    wristUI = createWristUI()
    wristUI.mesh.position.set(0, -0.05, 0.08); wristUI.mesh.rotation.x = -Math.PI / 3; hand.add(wristUI.mesh)
  }

  function updateWristUI(health, ammo, reloading) {
    if (!wristUI) return
    const ctx = wristUI.ctx, canvas = wristUI.canvas
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 4; ctx.strokeRect(0, 0, canvas.width, canvas.height)
    ctx.font = 'bold 36px monospace'; ctx.textAlign = 'left'
    ctx.fillStyle = health > 60 ? '#00ff00' : health > 30 ? '#ffff00' : '#ff0000'
    ctx.fillText(`HP ${Math.round(health)}`, 10, 45)
    ctx.textAlign = 'right'; ctx.fillStyle = reloading ? '#ffff00' : '#00ffff'
    ctx.fillText(reloading ? 'RELOAD' : String(ammo ?? ''), 246, 45)
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
    return { mesh, canvas, ctx, texture }
  }

  function setSettings(next) {
    settings = { ...next }
    updateSettingsPanel()
  }

  function updateSettingsPanel() {
    if (!vrSettingsPanel) return
    const ctx = vrSettingsPanel.ctx, canvas = vrSettingsPanel.canvas
    ctx.fillStyle = 'rgba(20,20,40,0.95)'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.strokeStyle = '#00ffff'; ctx.lineWidth = 4; ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20)
    ctx.font = 'bold 32px sans-serif'; ctx.fillStyle = '#00ffff'; ctx.textAlign = 'center'; ctx.fillText('VR SETTINGS', 256, 50)
    ctx.font = '24px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'
    ctx.fillText(`Snap Turn: ${settings.snapTurnAngle}deg`, 40, 120); ctx.fillText('[B/Y] to cycle', 280, 120)
    ctx.fillText(`Smooth Turn: ${settings.smoothTurnSpeed === 0 ? 'OFF' : settings.smoothTurnSpeed.toFixed(1)}`, 40, 180); ctx.fillText('[X/A] to cycle', 280, 180)
    ctx.fillText(`Vignette: ${settings.vignetteEnabled ? 'ON' : 'OFF'}`, 40, 240); ctx.fillText('[Grip] to toggle', 280, 240)
    ctx.fillText(`Height: ${settings.playerHeight.toFixed(2)}m`, 40, 300); ctx.fillText('[Menu] adjust', 280, 300)
    ctx.fillStyle = settings.teleportEnabled ? '#00ff00' : '#ff0000'
    ctx.fillText(`Teleport: ${settings.teleportEnabled ? 'ON' : 'OFF'}`, 40, 360)
    ctx.fillStyle = '#ffffff'; ctx.fillText('[Trigger] toggle', 280, 360)
    ctx.fillStyle = '#888888'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Press [Menu] button to close', 256, 480)
    vrSettingsPanel.texture.needsUpdate = true
  }

  function toggleSettings() {
    if (!vrSettingsPanel) { vrSettingsPanel = createSettingsPanel(); camera.add(vrSettingsPanel.mesh) }
    vrSettingsPanel.mesh.visible = !vrSettingsPanel.mesh.visible
    if (vrSettingsPanel.mesh.visible) updateSettingsPanel()
  }

  function initTeleport() {
    teleportArc = createRayLine({ color: 0x00ffff, opacity: 0.6, name: 'teleportArc', segments: ARC_SEGMENTS })
    teleportArc.visible = false; scene.add(teleportArc)
    teleportMarker = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 32), new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide }))
    teleportMarker.name = 'teleportMarker'; teleportMarker.rotation.x = -Math.PI / 2; teleportMarker.visible = false; scene.add(teleportMarker)
  }

  function executeTeleport(pt) {
    if (teleportPending) return
    teleportPending = { pt }
    _fadeActor.send({ type: 'START' })
    teleportTimer = setTimeout(moveTeleport, TELEPORT_MOVE_MS)
  }

  function moveTeleport() {
    const pending = teleportPending
    if (!pending) return
    if (!moveXROrigin(pending.pt)) { endTeleport(true); return }
    teleportTimer = setTimeout(() => endTeleport(false), TELEPORT_SETTLE_MS)
  }

  function endTeleport(aborted) {
    clearTimeout(teleportTimer); teleportTimer = 0
    teleportPending = null
    if (aborted) _fadeActor.send({ type: 'DONE' })
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

  function updateTeleportArc(pointer) {
    if (!teleportArc || !settings.teleportEnabled || !pointer) { if (teleportArc) teleportArc.visible = false; if (teleportMarker) teleportMarker.visible = false; return }
    const hit = computeParabolicArc(pointer.origin, pointer.direction)
    if (hit?.valid) { teleportMarker.position.set(hit.point.x, hit.point.y + 0.02, hit.point.z); teleportMarker.material.color.setHex(0x00ff00); teleportMarker.visible = true; if (pointer.trigger && !teleportPending) executeTeleport(hit.point) }
    else { teleportMarker.visible = false }
  }

  function updateFade(dt) {
    if (!fadeQuad) fadeQuad = createScreenQuad({ renderOrder: 9999, z: -0.1, material: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false }) })
    const fs = _fadeActor.getSnapshot().value
    if (fs === 'fadeIn') { fadeOpacity += FADE_SPEED * dt; if (fadeOpacity >= 1) { fadeOpacity = 1; fadeDelayElapsed = 0; _fadeActor.send({ type: 'FULL' }) } }
    else if (fs === 'delay') { fadeDelayElapsed += dt; if (fadeDelayElapsed >= FADE_DELAY_S) { fadeDelayElapsed = 0; _fadeActor.send({ type: 'RESUME' }) } }
    else if (fs === 'fadeOut') { fadeOpacity -= FADE_SPEED * dt; if (fadeOpacity <= 0) { fadeOpacity = 0; _fadeActor.send({ type: 'DONE' }) } }
    setQuadOpacity(fadeQuad, fadeOpacity)
  }

  function updateVignette(dt, isMoving) {
    if (!settings.vignetteEnabled) { if (vignetteMesh) vignetteMesh.visible = false; return }
    if (!vignetteMesh) {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512
      const ctx = canvas.getContext('2d'), g = ctx.createRadialGradient(256, 256, 100, 256, 256, 400)
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0.8)')
      ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512)
      vignetteMesh = createScreenQuad({ renderOrder: 9998, z: -0.15, material: new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0, depthTest: false, depthWrite: false }) })
    }
    vignetteTargetOpacity = isMoving ? 0.6 : 0
    vignetteOpacity += (vignetteTargetOpacity - vignetteOpacity) * 5 * dt
    setQuadOpacity(vignetteMesh, vignetteOpacity)
  }

  return { initWristUI, updateWristUI, toggleSettings, setSettings, initTeleport, updateTeleportArc, updateFade, updateVignette, get isTeleporting() { return teleportPending !== null }, get settingsVisible() { return vrSettingsPanel?.mesh.visible || false } }
}
