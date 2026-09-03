// Corner minimap HUD widget: renders the server-baked top-down color+height minimap
// (scripts/bake-minimap.mjs, wired onto the wire via worldDef._minimap -- see src/sdk/ServerAPI.js's
// bakeMinimapIfMissing / src/sdk/WorkerEntry.js's singleplayer-degraded metadata) plus a live rotating
// player-position dot in a small fixed corner widget. Follow-up to minimap-bake-topdown-color-height-
// per-seed; see PRD row minimap-hud-editor-ui-integration.
//
// COORDINATE MAPPING: the bake samples a square of `extent` local-frame meters centered on `center`
// (both from worldDef._minimap, the SAME fields scripts/bake-minimap.mjs used to generate the PNG --
// see bakeMinimap()'s `half = extent/2` / `center` usage), producing an N x N grid where pixel (0,0) is
// the MIN corner (center - half) and pixel (N-1,N-1) is the MAX corner (center + half), one row per
// increasing z (see bake's `for (iz) { z = center[1] - half + iz*step` loop -- iz is the image ROW/Y,
// local z is spoint's north-ish planar axis, not the image's own "north" notion). A player's local
// (x,z) (from PlanetFrame's frame -- see TerrainBackdrop.js/window.__terrain, authoritative/unshifted
// coordinate from FloatingOrigin.toAuthoritative) maps to normalized [0,1] via
// (x - (center.x-half)) / extent, (z - (center.y-half)) / extent, then to canvas pixels by multiplying
// the widget's drawn size. No rotation is applied (the bake has no camera-relative concept -- it is a
// fixed north-up top-down projection over local x/z), matching a conventional top-down minimap.
//
// DEGRADE-TO-HIDDEN: worldDef._minimap can be absent (a world with terrain disabled or a non-finite
// seed never gets the field set -- see ServerAPI.js/WorkerEntry.js), or present but the PNG/JSON 404
// (singleplayer's in-Worker path publishes the SAME metadata shape a real server boot would but never
// bakes anything itself -- see WorkerEntry.js's comment -- so a session that never had a real `node
// server.js` boot for this exact world+seed has no file on disk yet). Either case leaves the widget
// permanently hidden rather than showing a broken-image icon or throwing.

const SIZE_PX = 168 // widget diameter/side, before device-pixel-ratio scaling
const DOT_RADIUS_PX = 4

function ensureStyles() {
  if (document.getElementById('minimap-hud-style')) return
  const style = document.createElement('style')
  style.id = 'minimap-hud-style'
  style.textContent = `
#minimap-hud {
  position: fixed; top: 10px; right: 10px; z-index: 9400;
  width: ${SIZE_PX}px; height: ${SIZE_PX}px;
  border-radius: 8px; overflow: hidden;
  border: 1px solid var(--rule, rgba(0, 210, 255, 0.35));
  box-shadow: 0 2px 10px rgba(0,0,0,0.45);
  background: rgba(4,10,16,0.55);
  pointer-events: none;
  display: none;
}
#minimap-hud canvas { display: block; width: 100%; height: 100%; }
`
  document.head.appendChild(style)
}

// worldDef._minimap -> { base, center: [x,z], extent } (see src/sdk/ServerAPI.js). Fetches base+'.json'
// (header: N, minHeight, maxHeight, ...) then base+'.png' as an Image; both must succeed to arm the
// widget. getLocalXZ() returns the live player's authoritative local (x,z), or null while unavailable
// (no player mesh yet / floating origin not ready) -- a null read just skips the dot this frame.
export function createMinimapHUD(minimapMeta, getLocalXZ) {
  ensureStyles()
  const state = { armed: false, header: null, img: null }
  if (!minimapMeta || !minimapMeta.base || !Array.isArray(minimapMeta.center) || !Number.isFinite(minimapMeta.extent) || minimapMeta.extent <= 0) {
    return { update() {}, dispose() {} }
  }

  const root = document.createElement('div')
  root.id = 'minimap-hud'
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(SIZE_PX * dpr); canvas.height = Math.round(SIZE_PX * dpr)
  const ctx2d = canvas.getContext('2d')
  root.appendChild(canvas)
  document.body.appendChild(root)

  async function load() {
    try {
      const res = await fetch(minimapMeta.base + '.json')
      if (!res.ok) return
      const header = await res.json()
      if (!header || !Number.isFinite(header.N) || header.N < 2) return
      const img = new Image()
      const loaded = new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject })
      img.src = minimapMeta.base + '.png'
      await loaded
      state.header = header
      state.img = img
      state.armed = true
      root.style.display = 'block'
      _drawBase()
    } catch (e) {
      // 404/network error/decode failure -- soft-fail to permanently hidden, never throws into the caller's render loop.
      state.armed = false
    }
  }
  load()

  function _drawBase() {
    if (!state.img) return
    ctx2d.clearRect(0, 0, canvas.width, canvas.height)
    ctx2d.drawImage(state.img, 0, 0, canvas.width, canvas.height)
  }

  // update(): called once per client frame (cheap no-op while unarmed). Redraws the base image + player
  // dot every call rather than diffing -- a 168px canvas blit is trivial next to the rest of the frame,
  // and this avoids a second code path for "was the dot in a different place last frame".
  function update() {
    if (!state.armed) return
    _drawBase()
    const p = getLocalXZ && getLocalXZ()
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return
    const [cx, cz] = minimapMeta.center
    const half = minimapMeta.extent / 2
    const u = (p.x - (cx - half)) / minimapMeta.extent
    const v = (p.z - (cz - half)) / minimapMeta.extent
    if (u < 0 || u > 1 || v < 0 || v > 1) return // player outside the baked extent -- no dot rather than a clamped-wrong one
    const px = u * canvas.width, py = v * canvas.height
    const r = DOT_RADIUS_PX * dpr
    ctx2d.beginPath()
    ctx2d.arc(px, py, r, 0, Math.PI * 2)
    ctx2d.fillStyle = '#ffdd33'
    ctx2d.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx2d.lineWidth = 1.5 * dpr
    ctx2d.fill(); ctx2d.stroke()
  }

  function dispose() { root.remove() }

  return { update, dispose }
}
