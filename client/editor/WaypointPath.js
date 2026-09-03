// Waypoint path-line viewport visualization (waypoint-viewport-drag-path-visualization, 2nd deferred
// piece of moving-platform-keyframe-timeline-followup/WaypointTimeline.js's own header comment). Draws a
// persistent THREE.Line through the live ordered waypoint entities (same custom._waypoint+order data model
// WaypointTimeline.js's collectWaypointRows already reads) so a maker can see path order directly in the
// viewport, not just in the timeline panel's numbered list. Direct viewport DRAG of a waypoint marker is
// deliberately NOT a separate bespoke interaction here -- once a waypoint entity is selected (panel row
// click or a direct scene click, both already real), it drags exactly like any other entity via the
// existing generic translate/rotate/scale gizmo in editor.js (createEditor's attachGizmo/onPointerMove
// chain, entirely entity-id-generic, no waypoint special-casing needed or wanted -- a bespoke duplicate
// gizmo for one entity type would only add a second, divergent drag code path to keep in sync with the
// real one). This module owns exactly the path-line: a THREE.Group holding one THREE.Line (ordered
// vertices) plus small sphere markers at each waypoint (order-index sprite via a canvas-texture label),
// added/removed from `scene` the same lazy on/off-toggle shape as editor.js's own radiusGizmoGroup/
// minimapOverlayMesh (see editor.js's attachRadiusGizmo/toggleMinimapOverlay for the precedent).
import * as THREE from 'three'

// Pure: same filter+sort as WaypointTimeline.js's collectWaypointRows, duplicated here (not imported) so
// this module has zero dependency on the DOM-facing timeline panel -- it only needs entity data, not the
// panel's own h()/applyDiff rendering. Kept byte-identical in shape (same fields) so a future shared
// extraction is a pure move, not a behavior change.
export function collectWaypointPathPoints(entities) {
  const flat = []
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n && n.id) flat.push(n)
      if (n && n.children && n.children.length) walk(n.children)
    }
  }
  walk(entities)
  return flat
    .filter(n => n.custom && n.custom._waypoint)
    .map(n => ({ id: n.id, order: n.custom.order ?? 0, position: Array.isArray(n.position) ? n.position : [0, 0, 0] }))
    .sort((a, b) => a.order - b.order)
}

const _LINE_COLOR = 0xffcc00   // matches apps/waypoint/index.js's default marker color (#ffcc00)
const _LINE_COLOR_SELECTED = 0x00ffff

function _makeOrderLabelSprite(index) {
  // Small canvas-texture numeric label so a maker can tell path ORDER apart at a glance in the viewport
  // (the timeline panel already shows this as its row index -- this mirrors it in-scene), not just count
  // of markers. 64x64 canvas, big bold digit, transparent background.
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 64, 64)
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath(); ctx.arc(32, 32, 28, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 32px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(String(index), 32, 34)
  const tex = new THREE.CanvasTexture(canvas)
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(0.6, 0.6, 1)
  sprite.renderOrder = 998
  return sprite
}

// createWaypointPathOverlay({ scene, entityMeshes }): owns a single THREE.Group (line + per-point
// order-label sprites), created lazily on first update() call carrying >=1 point, torn down to null when
// empty or on destroy(). Same create/rebuild-on-change shape as editor.js's _setRadiusGizmoRadius (cheap
// enough -- at most a few dozen waypoints in practice -- to fully rebuild the line/sprites on every update
// rather than diff individual vertices). entityMeshes (optional, the SAME live Map createEditor already
// holds) is consulted for each waypoint id's CURRENT mesh.position when present -- this is what makes the
// line track a live in-progress gizmo drag frame-by-frame (the mesh moves locally every pointermove, well
// before any EDITOR_UPDATE commit reaches the server and comes back through a fresh SCENE_GRAPH entity
// list) instead of only updating on the next server round-trip. Falls back to the entity list's own
// position field for any id not yet in entityMeshes (e.g. the instant after PLACE_APP, before the mesh
// has loaded).
export function createWaypointPathOverlay({ scene, entityMeshes }) {
  let _group = null
  let _lastKey = ''   // cheap change-detection: join of id:x,y,z per point, skip rebuild if unchanged

  function _pointsKey(points) {
    return points.map(p => `${p.id}:${p.position[0].toFixed(3)},${p.position[1].toFixed(3)},${p.position[2].toFixed(3)}`).join('|')
  }

  function _teardown() {
    if (!_group) return
    scene.remove(_group)
    _group.traverse(o => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) {
        if (o.material.map) o.material.map.dispose()
        o.material.dispose()
      }
    })
    _group = null
    _lastKey = ''
  }

  function _build(points, selectedId) {
    const g = new THREE.Group()
    g.userData.isWaypointPath = true
    if (points.length >= 2) {
      const verts = new Float32Array(points.length * 3)
      points.forEach((p, i) => { verts[i * 3] = p.position[0]; verts[i * 3 + 1] = p.position[1]; verts[i * 3 + 2] = p.position[2] })
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
      const mat = new THREE.LineBasicMaterial({ color: _LINE_COLOR, depthTest: false, transparent: true, opacity: 0.85, linewidth: 2 })
      const line = new THREE.Line(geo, mat)
      line.renderOrder = 997
      g.add(line)
    }
    points.forEach((p, i) => {
      const sprite = _makeOrderLabelSprite(i)
      sprite.position.set(p.position[0], p.position[1] + 0.9, p.position[2])
      if (p.id === selectedId) sprite.material.color.setHex(_LINE_COLOR_SELECTED)
      g.add(sprite)
    })
    return g
  }

  return {
    // Fed the same live SCENE_GRAPH-derived entity tree EditorShell/editor.js already track. selectedId
    // (optional) highlights the current selection's order label so a maker can correlate a viewport
    // marker with the timeline panel's highlighted row. Live mesh positions (entityMeshes, when supplied
    // at construction) override the entity list's own (possibly-stale-during-a-drag) position field.
    update(entities, selectedId) {
      const points = collectWaypointPathPoints(entities)
      if (entityMeshes) {
        for (const p of points) {
          const m = entityMeshes.get(p.id)
          if (m) p.position = [m.position.x, m.position.y, m.position.z]
        }
      }
      const key = _pointsKey(points) + '|sel:' + (selectedId || '')
      if (key === _lastKey) return   // no-op: identical positions/order/selection since last update
      _lastKey = key
      _teardown()
      if (points.length < 1) return   // nothing to draw
      _group = _build(points, selectedId)
      scene.add(_group)
    },
    get visible() { return !!_group },
    destroy() { _teardown() }
  }
}

export { collectWaypointPathPoints as _collectWaypointPathPoints }
