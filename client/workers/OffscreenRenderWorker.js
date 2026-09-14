import * as THREE from '/node_modules/three/build/three.module.js'

let renderer = null
let scene = null
let camera = null
let mesh = null
let running = false
let frameCount = 0
let lastStatsPost = 0
let rafHandle = 0
const STATS_POST_INTERVAL_MS = 250

function buildScene(width, height) {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x10141c)

  camera = new THREE.PerspectiveCamera(50, width / Math.max(1, height), 0.1, 100)
  camera.position.set(0, 2, 6)
  camera.lookAt(0, 0, 0)

  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  const dir = new THREE.DirectionalLight(0xffffff, 1.2)
  dir.position.set(3, 5, 2)
  scene.add(ambient, dir)

  const geo = new THREE.TorusKnotGeometry(1, 0.35, 128, 24)
  const mat = new THREE.MeshStandardMaterial({ color: 0x4fa3ff, roughness: 0.35, metalness: 0.15 })
  mesh = new THREE.Mesh(geo, mat)
  scene.add(mesh)
}

function tick(nowMs) {
  if (!running) return
  mesh.rotation.x += 0.008
  mesh.rotation.y += 0.013
  renderer.render(scene, camera)
  frameCount++

  if (nowMs - lastStatsPost > STATS_POST_INTERVAL_MS) {
    lastStatsPost = nowMs
    const info = renderer.info
    self.postMessage({
      type: 'frame',
      frame: frameCount,
      ms: nowMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles
    })
  }

  rafHandle = self.requestAnimationFrame(tick)
}

self.onmessage = (e) => {
  const msg = e.data || {}
  try {
    switch (msg.type) {
      case 'init': {
        const { canvas, width, height, dpr } = msg
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
        renderer.setPixelRatio(dpr || 1)
        renderer.setSize(width, height, false)
        buildScene(width, height)
        running = true
        frameCount = 0
        lastStatsPost = 0
        self.postMessage({ type: 'ready' })
        rafHandle = self.requestAnimationFrame(tick)
        break
      }
      case 'resize': {
        const { width, height, dpr } = msg
        if (renderer && camera) {
          renderer.setPixelRatio(dpr || 1)
          renderer.setSize(width, height, false)
          camera.aspect = width / Math.max(1, height)
          camera.updateProjectionMatrix()
        }
        break
      }
      case 'stop': {
        running = false
        if (rafHandle) self.cancelAnimationFrame(rafHandle)
        if (renderer) { renderer.dispose(); renderer = null }
        self.postMessage({ type: 'stopped' })
        break
      }
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err), stack: err && err.stack || null })
  }
}
