// Gizmo mesh-building helpers for editor.js's createEditor: translate/rotate/scale handle geometry,
// hit-proxy construction, the closest-point-on-axis-line drag math, and the trigger-volume radius
// gizmo. Split out as editor.js's largest self-contained block -- each function here only touches
// THREE + its own params/module constants, never createEditor's own closure state (gizmoGroup,
// machine, scene, radiusGizmoGroup all stay in editor.js since attachGizmo/attachRadiusGizmo/
// _highlightAxis mutate them directly).

import * as THREE from 'three'

const _coarsePointer = () => (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches)

const RADIUS_HANDLE_COUNT = 4  // 4 draggable ring handles (N/E/S/W) for an easier target than the thin ring itself
const _RADIUS_COLOR = 0xffaa00

// Closest point on the 3D LINE through `origin` along direction `axis` to the mouse `ray` -- the
// standard closed-form for two skew lines' closest approach, well-conditioned for any camera
// angle except the ray running exactly parallel to axis (see onStart's comment for why this
// replaces plane-intersection for every single-axis dot-product-consumed drag response).
function _closestPointOnAxisLine(ray, origin, axis) {
  // Line 1: ray.origin + t1*ray.direction (mouse ray). Line 2: origin + t2*axis (the handle's axis).
  const w0 = ray.origin.clone().sub(origin)
  const a = ray.direction.dot(ray.direction)   // == 1 (ray.direction is unit length)
  const b = ray.direction.dot(axis)
  const c = axis.dot(axis)                      // == 1 (_axisVec always returns unit length)
  const d = ray.direction.dot(w0)
  const e = axis.dot(w0)
  const denom = a * c - b * b
  // denom -> 0 only when the ray runs parallel to axis (camera looking straight down the handle);
  // fall back to the origin itself rather than dividing by ~0 into a huge/NaN point.
  const t2 = Math.abs(denom) < 1e-8 ? 0 : (a * e - b * d) / denom
  return origin.clone().addScaledVector(axis, t2)
}

// Invisible enlarged pick proxy: coarse pointers get a bigger raycast target than the 0.04-thick visible handle.
function _addHitProxy(group, axis, geom, place) {
  const proxy = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ visible: false }))
  proxy.visible = false
  proxy.userData.gizmoAxis = axis
  proxy.userData.isHitProxy = true
  proxy.renderOrder = 1000
  place(proxy)
  group.add(proxy)
}
function _axisHitProxy(group, axis) {
  const fat = _coarsePointer() ? 0.34 : 0.14
  const geom = new THREE.CylinderGeometry(fat, fat, 1.3, 6)
  geom.translate(0, 0.65, 0)
  _addHitProxy(group, axis, geom, (p) => {
    if (axis === 'x') p.rotation.z = -Math.PI / 2
    else if (axis === 'z') p.rotation.x = Math.PI / 2
  })
}
function _ringHitProxy(group, axis, rx, ry) {
  const fat = _coarsePointer() ? 0.2 : 0.08
  const geom = new THREE.TorusGeometry(1, fat, 6, 24)
  _addHitProxy(group, axis, geom, (p) => { p.rotation.x = rx; p.rotation.y = ry })
}
const _HIGHLIGHT = 0xffff00
function _tagBaseColor(mesh) { mesh.userData.baseColor = mesh.material.color.getHex(); return mesh }
function buildTranslateGizmo() {
  const g = new THREE.Group(); g.userData.isGizmo = true; g.userData.mode = 'translate'
  for (const [axis, color, rx, rz] of [['x',0xff2222,0,-Math.PI/2],['y',0x22ff22,0,0],['z',0x2222ff,Math.PI/2,0]]) {
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false })
    const shaft = _tagBaseColor(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 8), mat))
    shaft.geometry.translate(0, 0.5, 0); shaft.rotation.x = rx; shaft.rotation.z = rz
    shaft.userData.gizmoAxis = axis; shaft.renderOrder = 999
    const cap = _tagBaseColor(new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.25, 8), mat))
    cap.geometry.translate(0, 0.125, 0)
    if (axis === 'x') { cap.rotation.z = -Math.PI/2; cap.position.set(1, 0, 0) }
    else if (axis === 'y') cap.position.set(0, 1, 0)
    else { cap.rotation.x = Math.PI/2; cap.position.set(0, 0, 1) }
    cap.userData.gizmoAxis = axis; cap.renderOrder = 999
    g.add(shaft); g.add(cap)
    _axisHitProxy(g, axis)
  }
  return g
}
function buildRotateGizmo() {
  const g = new THREE.Group(); g.userData.isGizmo = true; g.userData.mode = 'rotate'
  for (const [axis,color,rx,ry] of [['x',0xff2222,0,Math.PI/2],['y',0x22ff22,Math.PI/2,0],['z',0x2222ff,0,0]]) {
    const ring = _tagBaseColor(new THREE.Mesh(new THREE.TorusGeometry(1,0.04,8,32),new THREE.MeshBasicMaterial({color,depthTest:false,side:THREE.DoubleSide})))
    ring.rotation.x=rx;ring.rotation.y=ry;ring.userData.gizmoAxis=axis;ring.renderOrder=999;g.add(ring)
    _ringHitProxy(g, axis, rx, ry)
  }
  return g
}
function buildScaleGizmo() {
  const g = new THREE.Group(); g.userData.isGizmo = true; g.userData.mode = 'scale'
  for (const [axis,color,rx,rz,px,py,pz] of [['x',0xff2222,0,-Math.PI/2,1,0,0],['y',0x22ff22,0,0,0,1,0],['z',0x2222ff,Math.PI/2,0,0,0,1]]) {
    const mat=new THREE.MeshBasicMaterial({color,depthTest:false})
    const shaft=_tagBaseColor(new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,1,8),mat));shaft.geometry.translate(0,0.5,0);shaft.rotation.x=rx;shaft.rotation.z=rz;shaft.userData.gizmoAxis=axis;shaft.renderOrder=999
    const box=_tagBaseColor(new THREE.Mesh(new THREE.BoxGeometry(0.2,0.2,0.2),mat));box.position.set(px,py,pz);box.userData.gizmoAxis=axis;box.renderOrder=999
    g.add(shaft);g.add(box)
    _axisHitProxy(g, axis)
  }
  return g
}
function _highlightAxis(axis) {
  if (!gizmoGroup) return
  gizmoGroup.children.forEach(c => {
    if (!c.userData.gizmoAxis || c.userData.isHitProxy || c.userData.baseColor === undefined) return
    c.material.color.setHex(c.userData.gizmoAxis === axis ? _HIGHLIGHT : c.userData.baseColor)
  })
}
function _buildGizmo() { return _mode()==='rotate'?buildRotateGizmo():_mode()==='scale'?buildScaleGizmo():buildTranslateGizmo() }

// Radius-drag handle (trigger-volume-radius-gizmo-handle): a flat horizontal ring at the entity's
// Y position, radius matching custom.radius, shown ADDITIONALLY alongside whichever translate/
// rotate/scale gizmo is currently active -- not a 4th gizmoMode, since a radius-shaped entity still
// wants normal move/rotate/scale on its position/transform too. Separate group (radiusGizmoGroup)
// so it survives independently of gizmoGroup's per-mode rebuild in _buildGizmo/attachGizmo.
function _entityHasRadiusGizmo(mesh) {
  // Scoped to trigger-volume-shaped entities (custom._trigger, set by apps/trigger-volume/index.js
  // setup()) for this slice -- capture-zone/shrinking-zone-center reuse is a separate PRD row
  // (capture-zone-shrinking-zone-gizmo-followup-check) pending a check of whether their radius
  // semantics (capture-zone: static; shrinking-zone-center: server-shrinks-over-time) allow the
  // identical handle without a live-vs-authored-value conflict.
  return !!(mesh && mesh.userData?.custom?._trigger)
}
function _entityRadius(mesh) {
  const r = mesh?.userData?.custom?.radius
  return (typeof r === 'number' && Number.isFinite(r) && r > 0) ? r : 3
}
function buildRadiusGizmo(radius) {
  const g = new THREE.Group(); g.userData.isRadiusGizmo = true
  const ringMat = new THREE.MeshBasicMaterial({ color: _RADIUS_COLOR, depthTest: false, transparent: true, opacity: 0.85 })
  const ring = _tagBaseColor(new THREE.Mesh(new THREE.TorusGeometry(radius, 0.03, 6, 48), ringMat))
  ring.rotation.x = Math.PI / 2  // lie flat in the XZ plane (horizontal, matching a ground-footprint radius)
  ring.userData.gizmoAxis = 'radius'
  ring.renderOrder = 999
  g.add(ring)
  // 4 cardinal handle knobs, each an enlarged hit target (coarse-pointer-aware like _axisHitProxy)
  // sitting ON the ring so a drag can start from any of 4 directions, not just a thin-torus pick.
  const fat = _coarsePointer() ? 0.22 : 0.1
  for (let i = 0; i < RADIUS_HANDLE_COUNT; i++) {
    const ang = (i / RADIUS_HANDLE_COUNT) * Math.PI * 2
    const knob = _tagBaseColor(new THREE.Mesh(new THREE.SphereGeometry(fat, 10, 8), new THREE.MeshBasicMaterial({ color: _RADIUS_COLOR, depthTest: false, transparent: true, opacity: 0.85 })))
    knob.position.set(Math.cos(ang) * radius, 0, Math.sin(ang) * radius)
    knob.userData.gizmoAxis = 'radius'
    knob.renderOrder = 1000
    g.add(knob)
  }
  return g
}

export {
  _closestPointOnAxisLine, _addHitProxy, _axisHitProxy, _ringHitProxy, _tagBaseColor,
  buildTranslateGizmo, buildRotateGizmo, buildScaleGizmo,
  _entityHasRadiusGizmo, _entityRadius, buildRadiusGizmo, RADIUS_HANDLE_COUNT
}
