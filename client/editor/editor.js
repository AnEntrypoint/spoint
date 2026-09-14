import * as THREE from 'three'
import { components as C } from 'anentrypoint-design'
import { MSG } from '/src/protocol/MessageTypes.js'
import { showToast } from './EditPanelDOM.js'
import { STRINGS } from '../core/strings.js'
import { createWaypointPathOverlay } from './WaypointPath.js'
import {
  _closestPointOnAxisLine, _addHitProxy, _axisHitProxy, _ringHitProxy, _tagBaseColor,
  buildTranslateGizmo, buildRotateGizmo, buildScaleGizmo,
  _entityHasRadiusGizmo, _entityRadius, buildRadiusGizmo, RADIUS_HANDLE_COUNT
} from './EditorGizmoBuild.js'

function _bookmarkStorageKey() {
  let world = 'default'
  try { world = new URLSearchParams(location.search).get('world') || 'default' } catch (_) {}
  return 'ds-editor-cam-bookmarks-' + world
}
function loadCameraBookmarks() {
  try {
    const raw = localStorage.getItem(_bookmarkStorageKey())
    const obj = raw ? JSON.parse(raw) : {}
    return (obj && typeof obj === 'object') ? obj : {}
  } catch (_) { return {} }
}
function saveCameraBookmark(slot, position, rotation) {
  const all = loadCameraBookmarks()
  all[slot] = { position, rotation }
  try { localStorage.setItem(_bookmarkStorageKey(), JSON.stringify(all)) } catch (_) {}
  return all
}

export function createEditor({ scene, camera, renderer, client, entityMeshes, playerStates, machine, onCommitEdit, onEmptyDrag, raycastHitPoint, isLocked, floatingOrigin, onDestroyEntities }) {
  const _authScratch = new THREE.Vector3()
  const _authArr = (renderPos) => { if (!floatingOrigin) return [renderPos.x, renderPos.y, renderPos.z]; const a = floatingOrigin.toAuthoritative(renderPos, _authScratch); return [a.x, a.y, a.z] }
  let selectedEntityId = null, gizmoGroup = null, minimapOverlayMesh = null
  const waypointPath = createWaypointPathOverlay({ scene, entityMeshes })
  let _lastSceneEntities = []
  const extraSelectedIds = new Set()
  let dragAxis = null, dragStart = null, dragEntityStart = null, _dragBeforeState = null
  let _dragRadiusStart = null, _dragRadiusCenter = null
  let _extraDragStart = null
  let _onChange = null, _onTransformCommit = null, _onEditModeChange = null, _onDragUpdate = null, _onGizmoSpaceChange = null, _onPivotModeChange = null, _onPlaytestStart = null, _onPlaytestStop = null, _onCommandPalette = null
  const SCATTER_STEP = 2
  const MULTI_DROP_STAGGER = 1.5
  const MINIMAP_OVERLAY_GROUND_CLEARANCE = 0.05
  const DEFAULT_NUDGE_STEP = 0.25
  let _scatterPlaceFn = null, _scatterActive = false, _scatterLastPoint = null, _scatterCount = 0
  const editMode = () => machine.isEditor
  function _mode() { return machine.gizmoMode }
  const raycaster = new THREE.Raycaster()
  const _plane = new THREE.Plane()
  let _dragUsesAxisLine = false
  const _HIGHLIGHT = 0xffff00

  function _highlightAxis(axis) {
    if (!gizmoGroup) return
    gizmoGroup.children.forEach(c => {
      if (!c.userData.gizmoAxis || c.userData.isHitProxy || c.userData.baseColor === undefined) return
      c.material.color.setHex(c.userData.gizmoAxis === axis ? _HIGHLIGHT : c.userData.baseColor)
    })
  }
  function _buildGizmo() { return _mode()==='rotate'?buildRotateGizmo():_mode()==='scale'?buildScaleGizmo():buildTranslateGizmo() }

  let radiusGizmoGroup = null
  const _RADIUS_HIGHLIGHT = 0xffff00
  function attachRadiusGizmo(mesh) {
    if (radiusGizmoGroup) { scene.remove(radiusGizmoGroup); radiusGizmoGroup = null }
    if (!_entityHasRadiusGizmo(mesh)) return
    radiusGizmoGroup = buildRadiusGizmo(_entityRadius(mesh))
    radiusGizmoGroup.position.copy(mesh.position)
    scene.add(radiusGizmoGroup)
  }
  function _highlightRadiusHandle(on) {
    if (!radiusGizmoGroup) return
    radiusGizmoGroup.children.forEach(c => { if (c.userData.baseColor !== undefined) c.material.color.setHex(on ? _RADIUS_HIGHLIGHT : c.userData.baseColor) })
  }
  function _setRadiusGizmoRadius(radius) {
    if (!radiusGizmoGroup) return
    const pos = radiusGizmoGroup.position.clone()
    scene.remove(radiusGizmoGroup)
    radiusGizmoGroup = buildRadiusGizmo(Math.max(0.1, radius))
    radiusGizmoGroup.position.copy(pos)
    scene.add(radiusGizmoGroup)
  }

  function attachGizmo(id) {
    if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
    if (radiusGizmoGroup) { scene.remove(radiusGizmoGroup); radiusGizmoGroup = null }
    if (!editMode()) return
    const mesh = entityMeshes.get(id); if (!mesh) return
    gizmoGroup = _buildGizmo()
    gizmoGroup.position.copy(_pivotMode === 'centroid' && extraSelectedIds.size ? _computeCentroid([id, ...extraSelectedIds]) : mesh.position)
    scene.add(gizmoGroup)
    if (!extraSelectedIds.size) attachRadiusGizmo(mesh)
  }

  function selectEntity(id, entityData, { preserveExtras = false } = {}) {
    selectedEntityId = id
    if (!preserveExtras) extraSelectedIds.clear()
    machine.send(id != null ? 'SELECT' : 'DESELECT')
    if (editMode()) attachGizmo(id)
    if (_onChange) _onChange(id, entityData)
  }

  function eulerDegToQuat([ex, ey, ez]) {
    const [rx,ry,rz] = [ex*Math.PI/180, ey*Math.PI/180, ez*Math.PI/180]
    const cx=Math.cos(rx/2),sx=Math.sin(rx/2),cy=Math.cos(ry/2),sy=Math.sin(ry/2),cz=Math.cos(rz/2),sz=Math.sin(rz/2)
    return [sx*cy*cz-cx*sy*sz, cx*sy*cz+sx*cy*sz, cx*cy*sz-sx*sy*cz, cx*cy*cz+sx*sy*sz]
  }

  function getNDC(e) {
    const r = renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1)
  }

  function sendEditorUpdate(changes) {
    if (!selectedEntityId) return
    if (Array.isArray(changes.position)) changes = { ...changes, position: _authArr({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }) }
    if (onCommitEdit) try { onCommitEdit(selectedEntityId, changes) } catch (_) {}
    client.send(MSG.EDITOR_UPDATE, { entityId: selectedEntityId, changes })
  }

  let _clipboard = null
  function copySelectedEntity() {
    if (!selectedEntityId) return false
    const mesh = entityMeshes.get(selectedEntityId)
    if (!mesh) return false
    _clipboard = {
      position: mesh.position.toArray(),
      rotation: mesh.quaternion.toArray(),
      scale: mesh.scale.toArray(),
      custom: JSON.parse(JSON.stringify(mesh.userData.custom || {}))
    }
    return true
  }
  function pasteOntoSelectedEntity() {
    if (!_clipboard || !selectedEntityId) return false
    const mesh = entityMeshes.get(selectedEntityId)
    if (!mesh) return false
    const before = { position: mesh.position.toArray(), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: JSON.parse(JSON.stringify(mesh.userData.custom || {})) }
    const changes = { position: _clipboard.position.slice(), rotation: _clipboard.rotation.slice(), scale: _clipboard.scale.slice(), custom: JSON.parse(JSON.stringify(_clipboard.custom)) }
    mesh.position.fromArray(changes.position)
    mesh.quaternion.fromArray(changes.rotation)
    mesh.scale.fromArray(changes.scale)
    mesh.userData.custom = JSON.parse(JSON.stringify(changes.custom))
    if (gizmoGroup) gizmoGroup.position.copy(mesh.position)
    const wireChanges = Array.isArray(changes.position) ? { ...changes, position: _authArr({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }) } : changes
    if (onCommitEdit) try { onCommitEdit(selectedEntityId, wireChanges) } catch (_) {}
    client.send(MSG.EDITOR_UPDATE, { entityId: selectedEntityId, changes: wireChanges })
    if (_onTransformCommit) _onTransformCommit({ entityId: selectedEntityId, before, after: changes, kind: 'paste' })
    return true
  }

  const _AX = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) }
  let _tapStartX = 0, _tapStartY = 0, _dragMoved = false
  let _gizmoSpace = 'world'
  let _pivotMode = 'active'
  const _PIVOT_MODES = ['active', 'centroid', 'individual']
  let _dragPositionStart = null
  function _computeCentroid(ids) {
    const c = new THREE.Vector3(); let n = 0
    for (const id of ids) { const m = entityMeshes.get(id); if (!m) continue; c.add(m.position); n++ }
    return n ? c.multiplyScalar(1 / n) : c
  }
  function _axisVec(axis) {
    if (_gizmoSpace !== 'local') return _AX[axis]
    const mesh = entityMeshes.get(selectedEntityId)
    if (!mesh) return _AX[axis]
    return _AX[axis].clone().applyQuaternion(mesh.quaternion)
  }
  function setGizmoSpace(space) { _gizmoSpace = space === 'local' ? 'local' : 'world' }
  function setPivotMode(mode) {
    _pivotMode = _PIVOT_MODES.includes(mode) ? mode : 'active'
    if (selectedEntityId && !dragAxis) attachGizmo(selectedEntityId)
  }

  function pickEntity(e) {
    const meshList = []; entityMeshes.forEach((mesh, id) => { if (mesh.userData?.isEditable && !(isLocked && isLocked(id))) meshList.push({ mesh, id }) })
    const hits = raycaster.intersectObjects(meshList.map(m => m.mesh), true)
    if (!hits.length) return null
    const found = meshList.find(m => m.mesh.getObjectById ? m.mesh.getObjectById(hits[0].object.id) : m.mesh === hits[0].object)
    if (!found) return null
    const mesh = found.mesh
    return { id: found.id, ent: { id: found.id, position: _authArr(mesh.position), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} } }
  }

  const PRECISION_FINE = 0.1
  const PRECISION_COARSE = 10
  function _precisionScale(e) { return e.shiftKey ? PRECISION_FINE : e.altKey ? PRECISION_COARSE : 1 }
  const ROTATE_SNAP_DEG = 15

  const SNAP_TO_ENTITY_THRESHOLD = 0.75
  const _snapBox = new THREE.Box3()
  function _entityCandidatePoints(mesh) {
    _snapBox.setFromObject(mesh)
    if (_snapBox.isEmpty()) return [mesh.position.clone()]
    const { min, max } = _snapBox
    const c = _snapBox.getCenter(new THREE.Vector3())
    const pts = [c]
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) pts.push(new THREE.Vector3(x, y, z))
    pts.push(new THREE.Vector3(c.x, c.y, min.z), new THREE.Vector3(c.x, c.y, max.z))
    pts.push(new THREE.Vector3(c.x, min.y, c.z), new THREE.Vector3(c.x, max.y, c.z))
    pts.push(new THREE.Vector3(min.x, c.y, c.z), new THREE.Vector3(max.x, c.y, c.z))
    return pts
  }
  function _nearestEntitySnapPoint(candidatePos, excludeId) {
    let best = null, bestDist = SNAP_TO_ENTITY_THRESHOLD
    entityMeshes.forEach((mesh, id) => {
      if (id === excludeId || !mesh.userData?.isEditable) return
      for (const p of _entityCandidatePoints(mesh)) {
        const d = p.distanceTo(candidatePos)
        if (d < bestDist) { bestDist = d; best = p }
      }
    })
    return best
  }

  const _radiusPlane = new THREE.Plane()
  function _applyRadiusDrag(e) {
    if (!_dragRadiusCenter) return
    raycaster.setFromCamera(getNDC(e), camera)
    _radiusPlane.setFromNormalAndCoplanarPoint(_AX.y, _dragRadiusCenter)
    const pt = new THREE.Vector3()
    if (!raycaster.ray.intersectPlane(_radiusPlane, pt)) return
    let radius = pt.distanceTo(_dragRadiusCenter) * _precisionScale(e)
    if (machine.snapOn) radius = Math.round(radius / machine.snapSize) * machine.snapSize
    radius = Math.max(0.1, radius)
    _setRadiusGizmoRadius(radius)
    const mesh = entityMeshes.get(selectedEntityId)
    if (mesh) mesh.userData.custom = { ...(mesh.userData.custom || {}), radius }
    if (_onDragUpdate) _onDragUpdate(selectedEntityId, { custom: { radius } }, { clientX: e.clientX, clientY: e.clientY, axis: 'radius', mode: 'radius', delta: radius - _dragRadiusStart })
  }
  function _commitRadiusDrag() {
    const mesh = entityMeshes.get(selectedEntityId)
    const radius = mesh ? _entityRadius(mesh) : _dragRadiusStart
    sendEditorUpdate({ custom: { radius } })
    if (_onTransformCommit && _dragBeforeState) {
      _onTransformCommit({ entityId: selectedEntityId, before: _dragBeforeState, after: { custom: { radius } }, kind: 'radius' })
    }
    _highlightRadiusHandle(false)
    dragAxis = null; _dragRadiusStart = null; _dragRadiusCenter = null; _dragBeforeState = null
  }

  function applyGizmoDrag(e) {
    if (!dragAxis || !dragStart || !gizmoGroup) return
    raycaster.setFromCamera(getNDC(e), camera)
    let pt
    if (_dragUsesAxisLine) {
      const lineAxis = _mode() === 'rotate' ? (dragAxis === 'x' ? 'y' : 'x') : dragAxis
      pt = _closestPointOnAxisLine(raycaster.ray, gizmoGroup.position, _axisVec(lineAxis))
    } else {
      pt = new THREE.Vector3(); raycaster.ray.intersectPlane(_plane, pt); if (!pt) return
    }
    const delta = pt.clone().sub(dragStart).multiplyScalar(_precisionScale(e))
    const mesh = entityMeshes.get(selectedEntityId); if (!mesh) return
    const _centroidPivot = (_pivotMode === 'centroid' && _dragPositionStart) ? _computeCentroid(_dragPositionStart.keys()) : null
    if (_mode() === 'scale') {
      const s = dragEntityStart.clone()
      const d = delta.dot(_axisVec(dragAxis))
      if (dragAxis==='x') s.x = Math.max(0.01, s.x + d)
      else if (dragAxis==='y') s.y = Math.max(0.01, s.y + d)
      else s.z = Math.max(0.01, s.z + d)
      mesh.scale.copy(s)
      if (_centroidPivot) {
        const startPos = _dragPositionStart.get(selectedEntityId)
        const offset = startPos.clone().sub(_centroidPivot)
        offset.x *= dragEntityStart.x ? s.x / dragEntityStart.x : 1
        offset.y *= dragEntityStart.y ? s.y / dragEntityStart.y : 1
        offset.z *= dragEntityStart.z ? s.z / dragEntityStart.z : 1
        mesh.position.copy(_centroidPivot.clone().add(offset))
        if (gizmoGroup) gizmoGroup.position.copy(_centroidPivot)
      }
      if (_extraDragStart) for (const [eid, startScale] of _extraDragStart) {
        const em = entityMeshes.get(eid); if (!em) continue
        const es = startScale.clone()
        if (dragAxis==='x') es.x = Math.max(0.01, es.x + d)
        else if (dragAxis==='y') es.y = Math.max(0.01, es.y + d)
        else es.z = Math.max(0.01, es.z + d)
        em.scale.copy(es)
        if (_centroidPivot) {
          const startPos = _dragPositionStart.get(eid)
          const offset = startPos.clone().sub(_centroidPivot)
          offset.x *= startScale.x ? es.x / startScale.x : 1
          offset.y *= startScale.y ? es.y / startScale.y : 1
          offset.z *= startScale.z ? es.z / startScale.z : 1
          em.position.copy(_centroidPivot.clone().add(offset))
        }
      }
    } else if (_mode() === 'rotate') {
      const projAxis = dragAxis==='x'?'y':'x'
      let d = delta.dot(_axisVec(projAxis))
      if (machine.snapOn) {
        const stepDeg = ROTATE_SNAP_DEG
        const stepRad = stepDeg * Math.PI / 180
        d = Math.round(d / stepRad) * stepRad
      }
      const rotAxis = _axisVec(dragAxis)
      const q = new THREE.Quaternion().setFromAxisAngle(rotAxis, d)
      mesh.quaternion.copy(dragEntityStart.clone()).multiply(q)
      if (_centroidPivot) {
        const startPos = _dragPositionStart.get(selectedEntityId)
        mesh.position.copy(startPos.clone().sub(_centroidPivot).applyQuaternion(q).add(_centroidPivot))
        if (gizmoGroup) gizmoGroup.position.copy(_centroidPivot)
      }
      if (_extraDragStart) for (const [eid, startQuat] of _extraDragStart) {
        const em = entityMeshes.get(eid); if (!em) continue
        em.quaternion.copy(startQuat.clone()).multiply(q)
        if (_centroidPivot) {
          const startPos = _dragPositionStart.get(eid)
          em.position.copy(startPos.clone().sub(_centroidPivot).applyQuaternion(q).add(_centroidPivot))
        }
      }
    } else {
      const axisVec = _axisVec(dragAxis)
      const moveDelta = _gizmoSpace === 'local' ? axisVec.clone().multiplyScalar(delta.dot(axisVec)) : delta
      const newPos = dragEntityStart.clone().add(moveDelta)
      let snapDx = 0, snapDy = 0, snapDz = 0
      if (machine.snapOn) {
        const sz=machine.snapSize
        snapDx=Math.round((newPos.x-dragEntityStart.x)/sz)*sz - (newPos.x-dragEntityStart.x)
        snapDy=Math.round((newPos.y-dragEntityStart.y)/sz)*sz - (newPos.y-dragEntityStart.y)
        snapDz=Math.round((newPos.z-dragEntityStart.z)/sz)*sz - (newPos.z-dragEntityStart.z)
        newPos.x+=snapDx; newPos.y+=snapDy; newPos.z+=snapDz
      }
      if (dragAxis === 'y' && e.ctrlKey && !machine.snapOn && raycastHitPoint) {
        const surfaceHit = raycastHitPoint(e.clientX, e.clientY)
        if (surfaceHit) newPos.y = surfaceHit.y
      }
      if (!machine.snapOn && !e.ctrlKey) {
        const snapped = _nearestEntitySnapPoint(newPos, selectedEntityId)
        if (snapped) newPos.copy(snapped)
      }
      gizmoGroup.position.copy(newPos); mesh.position.copy(newPos)
      if (_extraDragStart) {
        const worldDelta = newPos.clone().sub(dragEntityStart)
        for (const [eid, startPos] of _extraDragStart) {
          const em = entityMeshes.get(eid); if (!em) continue
          em.position.copy(startPos.clone().add(worldDelta))
        }
      }
    }
    if (_onDragUpdate) {
      const data = _mode() === 'scale' ? { scale: mesh.scale.toArray() } : _mode() === 'rotate' ? { rotation: mesh.quaternion.toArray() } : { position: mesh.position.toArray() }
      const deltaOnAxis = _mode() === 'scale' ? mesh.scale.getComponent(dragAxis==='x'?0:dragAxis==='y'?1:2) - dragEntityStart.getComponent(dragAxis==='x'?0:dragAxis==='y'?1:2) : delta.dot(_axisVec(dragAxis))
      _onDragUpdate(selectedEntityId, data, { clientX: e.clientX, clientY: e.clientY, axis: dragAxis, mode: _mode(), delta: deltaOnAxis })
    }
  }

  function commitGizmoDrag() {
    const _centroidMoved = _pivotMode === 'centroid' && !!_dragPositionStart
    const mesh = entityMeshes.get(selectedEntityId)
    if (mesh) {
      const changes = _mode() === 'scale' ? { scale: mesh.scale.toArray() } : _mode() === 'rotate' ? { rotation: mesh.quaternion.toArray() } : { position: mesh.position.toArray() }
      if (_centroidMoved && _mode() !== 'translate') changes.position = mesh.position.toArray()
      sendEditorUpdate(changes)
      if (_onTransformCommit && _dragBeforeState) {
        const after = { ...changes }
        const before = _centroidMoved && _mode() !== 'translate'
          ? { ..._dragBeforeState, position: _dragPositionStart.get(selectedEntityId).toArray() }
          : _dragBeforeState
        _onTransformCommit({ entityId: selectedEntityId, before, after, kind: _mode() })
      }
    }
    if (_extraDragStart) {
      for (const [eid, startVal] of _extraDragStart) {
        const em = entityMeshes.get(eid); if (!em) continue
        const changes = _mode() === 'scale' ? { scale: em.scale.toArray() } : _mode() === 'rotate' ? { rotation: em.quaternion.toArray() } : { position: em.position.toArray() }
        if (_centroidMoved && _mode() !== 'translate') changes.position = em.position.toArray()
        const wireChanges = Array.isArray(changes.position) ? { ...changes, position: _authArr({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }) } : changes
        if (onCommitEdit) try { onCommitEdit(eid, wireChanges) } catch (_) {}
        client.send(MSG.EDITOR_UPDATE, { entityId: eid, changes: wireChanges })
        if (_onTransformCommit) {
          const before = _mode() === 'scale' ? { scale: startVal.toArray() } : _mode() === 'rotate' ? { rotation: startVal.toArray() } : { position: startVal.toArray() }
          if (_centroidMoved && _mode() !== 'translate') before.position = _dragPositionStart.get(eid).toArray()
          _onTransformCommit({ entityId: eid, before, after: changes, kind: _mode() })
        }
      }
    }
    _highlightAxis(null)
    dragAxis = null; dragStart = null; dragEntityStart = null; _dragBeforeState = null; _extraDragStart = null; _dragPositionStart = null
    if (selectedEntityId) attachGizmo(selectedEntityId)
  }

  let _emptyDragActive = false, _emptyLastX = 0, _emptyLastY = 0
  let _boxSelectActive = false, _boxStartX = 0, _boxStartY = 0
  let _boxEl = null
  function _ensureBoxEl() {
    if (_boxEl) return _boxEl
    _boxEl = document.createElement('div')
    _boxEl.style.cssText = 'position:fixed;border:1px solid #4af;background:rgba(68,170,255,0.15);pointer-events:none;z-index:9999;display:none'
    document.body.appendChild(_boxEl)
    return _boxEl
  }
  function _updateBoxEl(x0, y0, x1, y1) {
    const el = _ensureBoxEl()
    const left = Math.min(x0, x1), top = Math.min(y0, y1)
    el.style.left = left + 'px'; el.style.top = top + 'px'
    el.style.width = Math.abs(x1 - x0) + 'px'; el.style.height = Math.abs(y1 - y0) + 'px'
    el.style.display = 'block'
  }
  function _finishBoxSelect(x0, y0, x1, y1, additive) {
    if (_boxEl) _boxEl.style.display = 'none'
    const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1)
    const rect = renderer.domElement.getBoundingClientRect()
    const proj = new THREE.Vector3()
    const hitIds = []
    entityMeshes.forEach((mesh, id) => {
      if (!mesh.userData?.isEditable) return
      proj.setFromMatrixPosition(mesh.matrixWorld).project(camera)
      if (proj.z < -1 || proj.z > 1) return
      const sx = rect.left + (proj.x * 0.5 + 0.5) * rect.width
      const sy = rect.top + (-proj.y * 0.5 + 0.5) * rect.height
      if (sx >= left && sx <= right && sy >= top && sy <= bottom) hitIds.push(id)
    })
    if (!hitIds.length) return
    if (!additive) extraSelectedIds.clear()
    let primary = selectedEntityId
    for (const id of hitIds) {
      if (primary == null) { primary = id; continue }
      if (id !== primary) extraSelectedIds.add(id)
    }
    if (primary != null && primary !== selectedEntityId) {
      const mesh = entityMeshes.get(primary)
      selectEntity(primary, mesh ? { id: primary, position: _authArr(mesh.position), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} } : null, { preserveExtras: true })
    } else if (_onChange) _onChange(selectedEntityId, null)
  }
  const _ptrDrag = C.usePointerDrag ? C.usePointerDrag(renderer.domElement, {
    onStart(e) {
      if (!editMode() || (e.button != null && e.button !== 0)) return false
      _tapStartX = e.clientX; _tapStartY = e.clientY; _dragMoved = false
      raycaster.setFromCamera(getNDC(e), camera)
      if (radiusGizmoGroup) {
        const rHits = raycaster.intersectObjects(radiusGizmoGroup.children, false)
        if (rHits.length > 0) {
          const mesh = entityMeshes.get(selectedEntityId)
          if (mesh) {
            dragAxis = 'radius'
            _highlightRadiusHandle(true)
            _dragRadiusStart = _entityRadius(mesh)
            _dragRadiusCenter = mesh.position.clone()
            _dragBeforeState = { custom: { radius: _dragRadiusStart } }
            if (e.cancelable) e.preventDefault()
            return true
          }
        }
      }
      if (gizmoGroup) {
        const hits = raycaster.intersectObjects(gizmoGroup.children, false)
        if (hits.length > 0) {
          dragAxis = hits[0].object.userData.gizmoAxis
          const mesh = entityMeshes.get(selectedEntityId)
          if (!mesh) { dragAxis = null; return false }
          _highlightAxis(dragAxis)
          dragEntityStart = _mode() === 'scale' ? mesh.scale.clone() : _mode() === 'rotate' ? mesh.quaternion.clone() : mesh.position.clone()
          _dragBeforeState = _mode() === 'scale' ? { scale: mesh.scale.toArray() } : _mode() === 'rotate' ? { rotation: mesh.quaternion.toArray() } : { position: mesh.position.toArray() }
          _extraDragStart = null
          _dragPositionStart = null
          if (extraSelectedIds.size) {
            _extraDragStart = new Map()
            _dragPositionStart = new Map([[selectedEntityId, mesh.position.clone()]])
            for (const eid of extraSelectedIds) {
              const em = entityMeshes.get(eid); if (!em) continue
              _extraDragStart.set(eid, _mode() === 'scale' ? em.scale.clone() : _mode() === 'rotate' ? em.quaternion.clone() : em.position.clone())
              _dragPositionStart.set(eid, em.position.clone())
            }
          }
          _dragUsesAxisLine = _mode() === 'scale' || _mode() === 'rotate' || (_mode() === 'translate' && _gizmoSpace === 'local')
          const _lineAxisForDrag = _mode() === 'rotate' ? (dragAxis === 'x' ? 'y' : 'x') : dragAxis
          let pt
          if (_dragUsesAxisLine) {
            pt = _closestPointOnAxisLine(raycaster.ray, gizmoGroup.position, _axisVec(_lineAxisForDrag))
          } else {
            const planeNormal = camera.getWorldDirection(new THREE.Vector3()).cross(_axisVec(dragAxis)).normalize()
            _plane.setFromNormalAndCoplanarPoint(planeNormal, gizmoGroup.position)
            pt = new THREE.Vector3(); raycaster.ray.intersectPlane(_plane, pt)
          }
          dragStart = pt
          if (e.cancelable) e.preventDefault()
          return true
        }
      }
      const hit = pickEntity(e)
      if (hit) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (hit.id !== selectedEntityId) {
            if (extraSelectedIds.has(hit.id)) extraSelectedIds.delete(hit.id); else extraSelectedIds.add(hit.id)
            if (_onChange) _onChange(selectedEntityId, null)
          }
        } else {
          extraSelectedIds.clear()
          selectEntity(hit.id, hit.ent)
        }
      } else if (_scatterPlaceFn) {
        _scatterActive = true; _scatterCount = 0
        const p = raycastHitPoint ? raycastHitPoint(e.clientX, e.clientY) : null
        _scatterLastPoint = p
        if (p) { _scatterPlaceFn(p); _scatterCount++ }
      } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
        _boxSelectActive = true; _boxStartX = e.clientX; _boxStartY = e.clientY
      } else if (onEmptyDrag) { _emptyDragActive = true; _emptyLastX = e.clientX; _emptyLastY = e.clientY }
      return true
    },
    onMove(e) {
      if (Math.hypot(e.clientX - _tapStartX, e.clientY - _tapStartY) > 4) _dragMoved = true
      if (_boxSelectActive) { _updateBoxEl(_boxStartX, _boxStartY, e.clientX, e.clientY); return }
      if (_scatterActive) {
        const p = raycastHitPoint ? raycastHitPoint(e.clientX, e.clientY) : null
        if (p && _scatterLastPoint && p.distanceTo(_scatterLastPoint) >= SCATTER_STEP) {
          _scatterPlaceFn(p); _scatterCount++; _scatterLastPoint = p
        } else if (p && !_scatterLastPoint) _scatterLastPoint = p
        return
      }
      if (_emptyDragActive) {
        const dx = e.clientX - _emptyLastX, dy = e.clientY - _emptyLastY
        _emptyLastX = e.clientX; _emptyLastY = e.clientY
        if (dx || dy) onEmptyDrag(dx, dy)
        return
      }
      if (dragAxis === 'radius') { _applyRadiusDrag(e); return }
      applyGizmoDrag(e)
    },
    onEnd(e, cancelled) {
      _emptyDragActive = false
      if (_scatterActive) {
        _scatterActive = false
        const n = _scatterCount
        _scatterPlaceFn = null; _scatterLastPoint = null; _scatterCount = 0
        if (n) showToast('Scattered ' + n + ' ' + (n === 1 ? STRINGS.editorScatterCopy : STRINGS.editorScatterCopies))
        return
      }
      if (_boxSelectActive) {
        _boxSelectActive = false
        if (!cancelled && _dragMoved) _finishBoxSelect(_boxStartX, _boxStartY, e.clientX, e.clientY, e.ctrlKey || e.metaKey)
        else if (_boxEl) _boxEl.style.display = 'none'
        return
      }
      if (cancelled) {
        if (dragAxis === 'radius') {
          const mesh = entityMeshes.get(selectedEntityId)
          if (mesh && _dragRadiusStart != null) mesh.userData.custom = { ...(mesh.userData.custom || {}), radius: _dragRadiusStart }
          _highlightRadiusHandle(null)
          dragAxis = null; _dragRadiusStart = null; _dragRadiusCenter = null; _dragBeforeState = null
          if (selectedEntityId) attachGizmo(selectedEntityId)
          return
        }
        _highlightAxis(null); dragAxis = null; dragStart = null; dragEntityStart = null; _dragBeforeState = null; _extraDragStart = null; _dragPositionStart = null; if (selectedEntityId) attachGizmo(selectedEntityId); return
      }
      if (dragAxis === 'radius') { _commitRadiusDrag(); return }
      if (dragAxis) commitGizmoDrag()
    }
  }) : null

  const _dropHint = () => { renderer.domElement.style.outline = '3px solid var(--accent, #4af)' }
  const _dropHintClear = () => { renderer.domElement.style.outline = '' }
  const _onDragOver = e => { if (!editMode()) return; e.preventDefault(); _dropHint() }
  const _onDragLeave = () => { if (!editMode()) return; _dropHintClear() }
  const _onDrop = async e => {
    if (!editMode()) return
    e.preventDefault(); _dropHintClear()
    const files = [...e.dataTransfer.files].filter(f => f.name.endsWith('.glb') || f.name.endsWith('.gltf') || f.name.endsWith('.vrm'))
    if (!files.length) return
    const local = playerStates.get(client.playerId)
    const baseYaw = local ? (local.yaw || 0) : 0
    const dropPoint = raycastHitPoint(e.clientX, e.clientY)
    let i = 0
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file)
      showToast(STRINGS.editorUploadingFile(file.name))
      try {
        const res = await fetch('/upload-model', { method: 'POST', body: fd })
        if (!res.ok) { showToast(STRINGS.editorUploadFailed(res.status === 413 ? 'file too large' : res.status === 400 ? 'invalid model' : 'server error'), 'error'); continue }
        const { url } = await res.json()
        const staggerOffset = i * MULTI_DROP_STAGGER
        const pos = dropPoint
          ? _authArr({ x: dropPoint.x + Math.sin(baseYaw) * staggerOffset, y: dropPoint.y, z: dropPoint.z + Math.cos(baseYaw) * staggerOffset })
          : local
          ? [local.position[0] + Math.sin(baseYaw) * (2 + staggerOffset), local.position[1], local.position[2] + Math.cos(baseYaw) * (2 + staggerOffset)]
          : [0, 0, 2 + staggerOffset]
        client.send(MSG.PLACE_MODEL, { url, position: pos })
        showToast(STRINGS.editorFilePlaced(file.name))
        i++
      } catch (err) { console.error('[editor] upload failed:', err.message); showToast(STRINGS.editorUploadFailed(err.message), 'error') }
    }
  }
  document.addEventListener("dragover", _onDragOver)
  document.addEventListener("dragleave", _onDragLeave)
  document.addEventListener('drop', _onDrop)
  let _prevTouchAction = null, _onEnabled = null
  function _applyEditMode(on) {
    const el = renderer.domElement
    if (on) { if (_prevTouchAction === null) _prevTouchAction = el.style.touchAction; el.style.touchAction = 'none' }
    else { el.style.touchAction = _prevTouchAction || ''; _prevTouchAction = null }
    if (!on && gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
    if (!on && radiusGizmoGroup) { scene.remove(radiusGizmoGroup); radiusGizmoGroup = null }
    if (on && selectedEntityId) attachGizmo(selectedEntityId)
    if (_onEditModeChange) _onEditModeChange(on)
  }
  const _machineSub = machine.subscribe(() => {
    const on = machine.isEditor
    if (on !== _onEnabled) { _onEnabled = on; _applyEditMode(on) }
  })

  function toggleMinimapOverlay() {
    if (minimapOverlayMesh) {
      scene.remove(minimapOverlayMesh)
      minimapOverlayMesh.geometry.dispose()
      minimapOverlayMesh.material.map?.dispose()
      minimapOverlayMesh.material.dispose()
      minimapOverlayMesh = null
      return false
    }
    const meta = (typeof window !== 'undefined') && window.__minimapMeta
    if (!meta || !meta.base || !Array.isArray(meta.center) || !Number.isFinite(meta.extent) || meta.extent <= 0) {
      showToast('No baked minimap available for this world/seed', 'error')
      return false
    }
    const loader = new THREE.TextureLoader()
    const tex = loader.load(meta.base + '.png',
      undefined,
      undefined,
      () => { showToast('Minimap image failed to load (not yet baked?)', 'error'); toggleMinimapOverlay() })
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false })
    const geo = new THREE.PlaneGeometry(meta.extent, meta.extent)
    geo.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = -1
    const authX = meta.center[0], authZ = meta.center[1]
    let groundY = 0
    try { const f = window.__terrain && window.__terrain.frame; if (f) groundY = f.groundHeightLocal(authX, authZ) } catch (_) {}
    const fo = window.__floatingOrigin
    if (fo) { const r = fo.toRender({ x: authX, y: groundY + MINIMAP_OVERLAY_GROUND_CLEARANCE, z: authZ }); mesh.position.copy(r) }
    else mesh.position.set(authX, groundY + MINIMAP_OVERLAY_GROUND_CLEARANCE, authZ)
    scene.add(mesh)
    minimapOverlayMesh = mesh
    return true
  }

  return {
    onKeyDown(e) {
      if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        machine.send('TOGGLE_EDITOR')
      }
      if (e.code === 'KeyP' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        if (e.cancelable) e.preventDefault()
        if (_onCommandPalette) _onCommandPalette()
        return
      }
      if (e.code === 'KeyT' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        if (e.cancelable) e.preventDefault()
        if (machine.isPlaytesting) {
          if (_onPlaytestStop) _onPlaytestStop()
        } else if (editMode()) {
          if (_onPlaytestStart) _onPlaytestStart()
        }
        return
      }
      if (editMode() && e.altKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        if (e.cancelable) e.preventDefault()
        const slot = e.code.slice(5)
        if (e.ctrlKey) {
          saveCameraBookmark(slot, camera.position.toArray(), camera.quaternion.toArray())
          showToast(STRINGS.editorCameraBookmarkSaved(slot))
        } else {
          const all = loadCameraBookmarks()
          const bm = all[slot]
          if (bm) {
            camera.position.fromArray(bm.position)
            camera.quaternion.fromArray(bm.rotation)
            showToast(STRINGS.editorCameraBookmarkRecalled(slot))
          } else {
            showToast(STRINGS.editorCameraBookmarkMissing(slot))
          }
        }
        return
      }
      if (editMode()) {
        if ((e.code === 'KeyG' || e.code === 'KeyW') && !e.ctrlKey && !e.metaKey && !e.altKey) { if (e.cancelable) e.preventDefault(); machine.send('TRANSLATE'); if (selectedEntityId) attachGizmo(selectedEntityId); else showToast(STRINGS.editorNoEntitySelected) }
        if ((e.code === 'KeyR' || e.code === 'KeyE') && !e.ctrlKey && !e.metaKey && !e.altKey) { if (e.cancelable) e.preventDefault(); machine.send('ROTATE'); if (selectedEntityId) attachGizmo(selectedEntityId); else showToast(STRINGS.editorNoEntitySelected) }
        if (e.code === 'KeyS' && e.altKey && !e.ctrlKey && !e.metaKey) { if (e.cancelable) e.preventDefault(); machine.send('SCALE'); if (selectedEntityId) attachGizmo(selectedEntityId); else showToast(STRINGS.editorNoEntitySelected) }
        if (e.code === 'KeyY' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.cancelable) e.preventDefault()
          setGizmoSpace(_gizmoSpace === 'local' ? 'world' : 'local')
          if (_onGizmoSpaceChange) _onGizmoSpaceChange(_gizmoSpace)
          showToast('Gizmo space: ' + _gizmoSpace)
        }
        if (e.code === 'KeyP' && e.altKey && !e.ctrlKey && !e.metaKey) {
          if (e.cancelable) e.preventDefault()
          const idx = _PIVOT_MODES.indexOf(_pivotMode)
          setPivotMode(_PIVOT_MODES[(idx + 1) % _PIVOT_MODES.length])
          if (_onPivotModeChange) _onPivotModeChange(_pivotMode)
          showToast('Pivot mode: ' + _pivotMode)
        }
        if (e.code === 'KeyF') {
          if (e.cancelable) e.preventDefault()
          if (!selectedEntityId) { showToast(STRINGS.editorNoEntitySelected); return }
          const mesh = entityMeshes.get(selectedEntityId)
          if (mesh) {
            const box = new THREE.Box3().setFromObject(mesh)
            const sphere = box.getBoundingSphere(new THREE.Sphere())
            const radius = Math.max(sphere.radius, 0.5)
            const fov = (camera.fov || 60) * Math.PI / 180
            const dist = (radius / Math.sin(fov / 2)) * 1.5
            const dir = camera.position.clone().sub(mesh.position)
            if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1)
            dir.normalize()
            camera.position.copy(mesh.position).addScaledVector(dir, dist)
            camera.lookAt(mesh.position)
          }
        }
        if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          if (e.cancelable) e.preventDefault()
          if (copySelectedEntity()) showToast(STRINGS.editorEntityCopied); else showToast(STRINGS.editorNoEntitySelected)
          return
        }
        if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          if (e.cancelable) e.preventDefault()
          if (pasteOntoSelectedEntity()) showToast(STRINGS.editorEntityPasted)
          else showToast(_clipboard ? STRINGS.editorNoEntitySelected : STRINGS.editorClipboardEmpty)
          return
        }
        const _nudgeKeys = { ArrowLeft: [-1,0,0], ArrowRight: [1,0,0], ArrowUp: [0,0,-1], ArrowDown: [0,0,1], PageUp: [0,1,0], PageDown: [0,-1,0] }
        if (_nudgeKeys[e.code] && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!selectedEntityId) { return }
          if (e.cancelable) e.preventDefault()
          const mesh = entityMeshes.get(selectedEntityId); if (!mesh) return
          const step = machine.snapOn ? machine.snapSize : DEFAULT_NUDGE_STEP
          const [dx, dy, dz] = _nudgeKeys[e.code]
          const _nudgeBefore = { position: mesh.position.toArray() }
          mesh.position.x += dx * step; mesh.position.y += dy * step; mesh.position.z += dz * step
          if (gizmoGroup) gizmoGroup.position.copy(mesh.position)
          sendEditorUpdate({ position: mesh.position.toArray() })
          if (_onTransformCommit) _onTransformCommit({ entityId: selectedEntityId, before: _nudgeBefore, after: { position: mesh.position.toArray() }, kind: 'nudge' })
          for (const eid of extraSelectedIds) {
            const em = entityMeshes.get(eid); if (!em) continue
            const _nudgeBeforeExtra = { position: em.position.toArray() }
            em.position.x += dx * step; em.position.y += dy * step; em.position.z += dz * step
            const wireChanges = { position: _authArr(em.position) }
            if (onCommitEdit) try { onCommitEdit(eid, wireChanges) } catch (_) {}
            if (_onTransformCommit) _onTransformCommit({ entityId: eid, before: _nudgeBeforeExtra, after: { position: em.position.toArray() }, kind: 'nudge' })
            client.send(MSG.EDITOR_UPDATE, { entityId: eid, changes: wireChanges })
          }
        }
      }
      if (e.code === 'Delete' && editMode()) {
        if (e.cancelable) e.preventDefault()
        if (!selectedEntityId) { showToast(STRINGS.editorNoEntitySelected); return }
        if (onDestroyEntities) { try { onDestroyEntities([selectedEntityId, ...extraSelectedIds]) } catch (_) {} }
        else {
          client.send(MSG.DESTROY_ENTITY, { entityId: selectedEntityId })
          for (const eid of extraSelectedIds) client.send(MSG.DESTROY_ENTITY, { entityId: eid })
        }
        if (extraSelectedIds.size) showToast(STRINGS.editorEntitiesDeleted(1 + extraSelectedIds.size))
        extraSelectedIds.clear()
        if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
        if (radiusGizmoGroup) { scene.remove(radiusGizmoGroup); radiusGizmoGroup = null }
        selectedEntityId = null
        if (_onChange) _onChange(null, null)
      }
    },
    onSelectionChange(fn) { _onChange = fn },
    onEditModeChange(fn) { _onEditModeChange = fn },
    onTransformCommit(cb) { _onTransformCommit = cb },
    onDragUpdate(cb) { _onDragUpdate = cb },
    onGizmoSpaceChange(fn) { _onGizmoSpaceChange = fn },
    onPivotModeChange(fn) { _onPivotModeChange = fn },
    sendEditorUpdate,
    eulerDegToQuat,
    selectEntity,
    get extraSelectedIds() { return extraSelectedIds },
    updateGizmo() {
      if (_lastSceneEntities.length) waypointPath.update(_lastSceneEntities, selectedEntityId)
      if (!gizmoGroup || !selectedEntityId || dragAxis) return
      const m = entityMeshes.get(selectedEntityId); if (!m) return
      gizmoGroup.position.copy(_pivotMode === 'centroid' && extraSelectedIds.size ? _computeCentroid([selectedEntityId, ...extraSelectedIds]) : m.position)
      if (radiusGizmoGroup) radiusGizmoGroup.position.copy(m.position)
    },
    destroy() {
      _ptrDrag?.destroy?.()
      _machineSub?.unsubscribe?.()
      document.removeEventListener('dragover', _onDragOver)
      document.removeEventListener('dragleave', _onDragLeave)
      document.removeEventListener('drop', _onDrop)
      if (_boxEl) { _boxEl.remove(); _boxEl = null }
      if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
      if (radiusGizmoGroup) { scene.remove(radiusGizmoGroup); radiusGizmoGroup = null }
      if (minimapOverlayMesh) { scene.remove(minimapOverlayMesh); minimapOverlayMesh.geometry.dispose(); minimapOverlayMesh.material.map?.dispose(); minimapOverlayMesh.material.dispose(); minimapOverlayMesh = null }
      waypointPath.destroy()
    },
    toggleMinimapOverlay,
    get minimapOverlayOn() { return !!minimapOverlayMesh },
    updateWaypointPath(entities) { _lastSceneEntities = entities || []; waypointPath.update(_lastSceneEntities, selectedEntityId) },
    isDragging() { return dragAxis !== null },
    get selectedEntityId() { return selectedEntityId },
    get gizmoMode() { return _mode() },
    setGizmoSpace,
    get gizmoSpace() { return _gizmoSpace },
    setPivotMode,
    get pivotMode() { return _pivotMode },
    armScatterPlace(placeFn) { _scatterPlaceFn = typeof placeFn === 'function' ? placeFn : null },
    get scatterArmed() { return !!_scatterPlaceFn },
    copySelectedEntity,
    pasteOntoSelectedEntity,
    get hasClipboard() { return !!_clipboard },
    onPlaytestStart(fn) { _onPlaytestStart = fn },
    onPlaytestStop(fn) { _onPlaytestStop = fn },
    onCommandPalette(fn) { _onCommandPalette = fn }
  }
}