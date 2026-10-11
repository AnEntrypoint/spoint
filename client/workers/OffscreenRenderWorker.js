import * as THREE from '/node_modules/three/build/three.module.js'

let renderer = null
let scene = null
let camera = null
let mesh = null
let running = false
let frameCount = 0
let lastStatsPost = 0
let rafHandle = 0
let seq = 0
let run = 0
const STATS_POST_INTERVAL_MS = 250

function post(message) {
  self.postMessage({ seq: ++seq, run, ...message })
}

function postError(code, message, stack) {
  post({ type: 'error', code, message, stack: stack || null })
}

function dimsAreValid(width, height) {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
}

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
    post({
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
        if (running) {
          postError('init-while-running', 'init refused: the render loop is already running (send stop first)')
          break
        }
        if (!canvas) {
          postError('init-no-canvas', 'init refused: msg.canvas is missing')
          break
        }
        if (!dimsAreValid(width, height)) {
          postError('bad-init-payload', 'init refused: width and height must be finite and positive, got ' + String(width) + 'x' + String(height))
          break
        }
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
        renderer.setPixelRatio(dpr || 1)
        renderer.setSize(width, height, false)
        buildScene(width, height)
        running = true
        run++
        frameCount = 0
        lastStatsPost = 0
        post({ type: 'ready' })
        rafHandle = self.requestAnimationFrame(tick)
        break
      }
      case 'resize': {
        const { width, height, dpr } = msg
        if (!dimsAreValid(width, height)) {
          postError('bad-resize-payload', 'resize refused: width and height must be finite and positive, got ' + String(width) + 'x' + String(height))
          break
        }
        if (renderer && camera) {
          renderer.setPixelRatio(dpr || 1)
          renderer.setSize(width, height, false)
          camera.aspect = width / Math.max(1, height)
          camera.updateProjectionMatrix()
        } else {
          postError('resize-no-render-target', 'resize ignored: no renderer or camera (init has not run, or stop already ran)')
        }
        break
      }
      case 'stop': {
        running = false
        if (rafHandle) self.cancelAnimationFrame(rafHandle)
        if (renderer) { renderer.dispose(); renderer = null }
        post({ type: 'stopped' })
        break
      }
      default: {
        postError('unknown-message-type', 'unknown message type: ' + String(msg && msg.type))
        break
      }
    }
  } catch (err) {
    postError('handler-threw', String(err && err.message || err), err && err.stack)
  }
}
