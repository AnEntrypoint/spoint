import * as THREE from '/node_modules/three/build/three.module.js'
import * as PROTOCOL from '../core/WorkerRenderProtocol.js'

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

function post(message) {
  self.postMessage(PROTOCOL.workerStamped(++seq, run, message))
}

function postError(code, message, stack) {
  post(PROTOCOL.workerRefusalMessage(code, message, stack))
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
  const renderStartMs = performance.now()
  renderer.render(scene, camera)
  const renderMs = performance.now() - renderStartMs
  frameCount++

  // frameCount === 1 is the first rendered frame, and it is posted unconditionally: `nowMs` here is
  // a worker-relative clock that starts at 0 when the worker is created, so the gate below reads
  // `nowMs - 0 > 250` as false for the first ~250ms of the loop and swallows every frame in it.
  // Swallowing the first frame is what left the first-frame cost unmeasured and made the reported
  // frame numbers start at whatever count the loop had reached a quarter second in.
  if (frameCount === 1 || nowMs - lastStatsPost > PROTOCOL.WORKER_CLOCK_MS.FRAME_STATS_GATE_MS) {
    lastStatsPost = nowMs
    const info = renderer.info
    post(PROTOCOL.workerFrameMessage(frameCount, nowMs, info.render.calls, info.render.triangles, renderMs))
  }

  rafHandle = self.requestAnimationFrame(tick)
}

self.onmessage = (e) => {
  const msg = e.data || {}
  try {
    switch (msg.type) {
      case PROTOCOL.WORKER_MESSAGE.INIT: {
        const { canvas, width, height, dpr } = msg
        if (running) {
          postError(PROTOCOL.WORKER_REFUSAL.INIT_WHILE_RUNNING, 'init refused: the render loop is already running (send stop first)')
          break
        }
        if (!canvas) {
          postError(PROTOCOL.WORKER_REFUSAL.INIT_NO_CANVAS, 'init refused: msg.canvas is missing')
          break
        }
        if (!PROTOCOL.workerDimsAreValid(width, height)) {
          postError(PROTOCOL.WORKER_REFUSAL.BAD_INIT_PAYLOAD, 'init refused: width and height must be finite and positive, got ' + String(width) + 'x' + String(height))
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
        post({ type: PROTOCOL.WORKER_MESSAGE.READY })
        rafHandle = self.requestAnimationFrame(tick)
        break
      }
      case PROTOCOL.WORKER_MESSAGE.RESIZE: {
        const { width, height, dpr } = msg
        if (!PROTOCOL.workerDimsAreValid(width, height)) {
          postError(PROTOCOL.WORKER_REFUSAL.BAD_RESIZE_PAYLOAD, 'resize refused: width and height must be finite and positive, got ' + String(width) + 'x' + String(height))
          break
        }
        if (renderer && camera) {
          renderer.setPixelRatio(dpr || 1)
          renderer.setSize(width, height, false)
          camera.aspect = width / Math.max(1, height)
          camera.updateProjectionMatrix()
        } else {
          postError(PROTOCOL.WORKER_REFUSAL.RESIZE_NO_RENDER_TARGET, 'resize ignored: no renderer or camera (init has not run, or stop already ran)')
        }
        break
      }
      case PROTOCOL.WORKER_MESSAGE.STOP: {
        running = false
        if (rafHandle) self.cancelAnimationFrame(rafHandle)
        if (renderer) { renderer.dispose(); renderer = null }
        post({ type: PROTOCOL.WORKER_MESSAGE.STOPPED })
        break
      }
      default: {
        postError(PROTOCOL.WORKER_REFUSAL.UNKNOWN_MESSAGE_TYPE, 'unknown message type: ' + String(msg && msg.type))
        break
      }
    }
  } catch (err) {
    postError(PROTOCOL.WORKER_REFUSAL.HANDLER_THREW, String(err && err.message || err), err && err.stack)
  }
}
