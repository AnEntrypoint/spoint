// OffscreenRenderWorker.js -- real worker-hosted WebGL2 render loop.
//
// First functional slice of the offscreencanvas-worker-migration-followup epic (see AGENTS.md /
// client/core/WorkerRenderer.js for the main-thread side). The prior session (offscreencanvas-worker-rendering)
// only DETECTED whether a worker-hosted render loop was viable; this file is the actual render loop: a
// real THREE.WebGLRenderer constructed against a transferred OffscreenCanvas, running entirely inside
// this dedicated Worker's global scope (no `window`, no `document` -- OffscreenCanvas + self only),
// driving its own requestAnimationFrame-equivalent loop (workers get a real `self.requestAnimationFrame`
// in every browser that supports OffscreenCanvas, per spec) and posting per-frame stats back to main.
//
// SCOPE (intentionally bounded, not the whole-game migration): this renders a small self-contained demo
// scene (a lit, animated mesh field) to prove the mechanism end-to-end -- canvas transfer, WebGL2-in-worker
// context creation, a real draw loop, resize proxying, and clean teardown -- WITHOUT touching the fragile
// main game render path (RenderGraph/ShadowPipeline/mapspinner compositing), which the epic's own PRD
// detail explicitly says needs a dedicated session and a full DOM/window proxy layer first (most of
// mapspinner's window.__* live-tuning reads, MobileControls, ConnectionStatus/SpectatorMode HUD DOM writes
// all assume a real `window`/`document` and are NOT worker-safe yet -- seeoffscreencanvas-dom-window-audit).
//
// Message protocol (postMessage, all worker-local, not the game's wire protocol):
//   -> {type:'init', canvas: OffscreenCanvas, width, height, dpr}
//   -> {type:'resize', width, height, dpr}
//   -> {type:'stop'}
//   <- {type:'ready'}
//   <- {type:'frame', frame, ms, drawCalls, triangles}   (throttled to ~4/sec, not every frame -- cheap telemetry)
//   <- {type:'error', message, stack}

// A module Worker does NOT inherit the main document's <script type="importmap"> (that only
// resolves bare specifiers for module graphs loaded by the document itself) -- confirmed live: a
// bare `import * as THREE from 'three'` here throws inside the worker with zero error detail
// surfaced to the main-thread onerror handler (browsers suppress cross-realm script-error message
// text by default), which is exactly the trap this comment exists to head off for the next editor.
// Import the real module path directly instead, mirroring the importmap's own target for 'three'
// (client/index.html's importmap: "three": "/node_modules/three/build/three.module.js").
import * as THREE from '/node_modules/three/build/three.module.js'

let renderer = null
let scene = null
let camera = null
let mesh = null
let running = false
let frameCount = 0
let lastStatsPost = 0
let rafHandle = 0

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

  // Throttled telemetry -- proves real frames are executing inside the worker without flooding
  // postMessage traffic (a 60fps per-frame post would itself be a perf regression vs. the point of
  // moving work OFF the main thread).
  if (nowMs - lastStatsPost > 250) {
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
