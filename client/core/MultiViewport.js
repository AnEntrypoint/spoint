// editor-multi-viewport (spoint-side half): real camera+render-loop plumbing for N additional
// orthographic/perspective panes rendered as picture-in-picture insets over the primary scene,
// entirely additive to the existing single-camera render path (RenderGraph.nodes.js's 'scene-color'
// node, terrain VDRS upscale, post-processing chain) -- none of that is touched or re-routed. Layout
// chrome (draggable panes, resize handles, a maximize toggle) belongs in AnEntrypoint/design per the
// GUI-kit rule; this module owns only the camera objects and the renderer.setViewport/setScissor +
// render() calls a design-kit panel would drive.
//
// Each viewport is a real THREE.Camera (orthographic top/front/side or a second perspective) plus a
// pixel-rect {x,y,width,height} in canvas space (THREE's setViewport/setScissor origin is
// bottom-left, same convention WebGL itself uses). update()'s caller passes the primary camera's
// world position/target once per frame so an orthographic pane can optionally follow it (followTarget)
// without a design-kit UI needing its own camera-sync logic.
import * as THREE from 'three'

const ORTHO_VIEWS = {
  top: { eye: [0, 1, 0], up: [0, 0, -1] },
  front: { eye: [0, 0, 1], up: [0, 1, 0] },
  side: { eye: [1, 0, 0], up: [0, 1, 0] },
}

export function createMultiViewport(renderer, scene) {
  const panes = new Map()   // id -> { camera, rect: {x,y,width,height}, followTarget, orthoSize, kind }
  let _nextId = 0

  // kind: 'perspective' | 'top' | 'front' | 'side'. rect in canvas pixels (bottom-left origin).
  // orthoSize: half-extent in world units for an orthographic pane's frustum (ignored for perspective).
  function addPane(kind, rect, opts = {}) {
    const id = 'vp' + (_nextId++)
    let camera
    if (kind === 'perspective') {
      camera = new THREE.PerspectiveCamera(opts.fov ?? 60, Math.max(1, rect.width) / Math.max(1, rect.height), opts.near ?? 0.1, opts.far ?? 2000)
    } else {
      const view = ORTHO_VIEWS[kind]
      if (!view) throw new Error(`createMultiViewport.addPane: unknown kind "${kind}"`)
      const halfW = (opts.orthoSize ?? 50) * (Math.max(1, rect.width) / Math.max(1, rect.height))
      const halfH = opts.orthoSize ?? 50
      camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, opts.near ?? -1000, opts.far ?? 1000)
      camera.up.set(...view.up)
    }
    const pane = { id, kind, camera, rect: { ...rect }, followTarget: opts.followTarget !== false, orthoSize: opts.orthoSize ?? 50, enabled: true }
    panes.set(id, pane)
    return id
  }

  function removePane(id) { panes.delete(id) }
  function setRect(id, rect) { const p = panes.get(id); if (p) { p.rect = { ...rect }; if (p.camera.isPerspectiveCamera) p.camera.aspect = Math.max(1, rect.width) / Math.max(1, rect.height) } }
  function setEnabled(id, enabled) { const p = panes.get(id); if (p) p.enabled = !!enabled }
  function getPane(id) { return panes.get(id) || null }
  function getPanes() { return [...panes.values()] }

  const _v = new THREE.Vector3()
  // Called once per frame, after the primary scene render (RenderGraph.nodes.js's 'scene-color' node
  // has already drawn to the full canvas) -- each enabled pane's own setViewport/setScissor narrows
  // subsequent draw calls to its rect, renders, and the caller must restore the full-canvas
  // viewport/scissor afterward (done here) so the primary render path's own next-frame setup is
  // never left in a partial-viewport state.
  function render(primaryCamera) {
    if (panes.size === 0) return
    const canvas = renderer.domElement
    const fullW = canvas.width, fullH = canvas.height
    const prevAutoClear = renderer.autoClear
    for (const p of panes.values()) {
      if (!p.enabled) continue
      if (p.followTarget && primaryCamera) {
        primaryCamera.getWorldPosition(_v)
        if (p.kind === 'perspective') {
          p.camera.position.copy(primaryCamera.position)
          p.camera.quaternion.copy(primaryCamera.quaternion)
        } else {
          const view = ORTHO_VIEWS[p.kind]
          const dist = p.orthoSize * 4
          p.camera.position.set(_v.x + view.eye[0] * dist, _v.y + view.eye[1] * dist, _v.z + view.eye[2] * dist)
          p.camera.lookAt(_v)
        }
      }
      p.camera.updateProjectionMatrix()
      renderer.setViewport(p.rect.x, p.rect.y, p.rect.width, p.rect.height)
      renderer.setScissor(p.rect.x, p.rect.y, p.rect.width, p.rect.height)
      renderer.setScissorTest(true)
      renderer.autoClear = true
      renderer.render(scene, p.camera)
    }
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, fullW, fullH)
    renderer.autoClear = prevAutoClear
  }

  function dispose() { panes.clear() }

  return { addPane, removePane, setRect, setEnabled, getPane, getPanes, render, dispose }
}
