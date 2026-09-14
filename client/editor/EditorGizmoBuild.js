import * as THREE from 'three'

const _coarsePointer = () => (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches)

const RADIUS_HANDLE_COUNT = 4
const _RADIUS_COLOR = 0xffaa00

function _closestPointOnAxisLine(ray, origin, axis) {
  const w0 = ray.origin.clone().sub(origin)
  const a = ray.direction.dot(ray.direction)
  const b = ray.direction.dot(axis)
  const c = axis.dot(axis)
  const d = ray.direction.dot(w0)
  const e = axis.dot(w0)
  const denom = a * c - b * b
  const rayParallelToAxis = Math.abs(denom) < 1e-8
  const t2 = rayParallelToAxis ? 0 : (a * e - b * d) / denom
  return origin.clone().addScaledVector(axis, t2)
}

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

function _entityHasRadiusGizmo(mesh) {
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
  ring.rotation.x = Math.PI / 2
  ring.userData.gizmoAxis = 'radius'
  ring.renderOrder = 999
  g.add(ring)
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
