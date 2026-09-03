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

// --- Camera bookmarks (editor-camera-bookmarks) -------------------------------------------
// localStorage-persisted per-world (keyed by the ?world= URL param, falling back to 'default'
// for singleplayer/no-param sessions so bookmarks still work there, just not world-scoped).
// Pure key/save/load helpers so the storage shape is exec_js-testable independent of THREE/DOM.
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
  // Every mesh.position/em.position read in this file is RENDER-space (kept near-zero by floating-origin
  // rebasing past core/FloatingOrigin.js's REBASE_THRESHOLD_M from spawn); every position sent to the
  // server via MSG.EDITOR_UPDATE/PLACE_MODEL crosses back into AUTHORITATIVE local-frame meters, or the
  // written position silently lands near the render-space origin instead of where the user dragged/typed
  // it once the session has rebased at least once (editor-inspector-gizmo-position-display-write-floating-
  // origin). _authArr converts a THREE.Vector3-like render-space position to a plain authoritative
  // [x,y,z] array for a `changes.position`/`position:` payload; a no-op passthrough (matching every other
  // fallback in this codebase, e.g. FloatingOrigin usage in app.js) if floatingOrigin wasn't supplied, so
  // this file degrades gracefully rather than throwing if some future caller omits it.
  const _authScratch = new THREE.Vector3()
  const _authArr = (renderPos) => { if (!floatingOrigin) return [renderPos.x, renderPos.y, renderPos.z]; const a = floatingOrigin.toAuthoritative(renderPos, _authScratch); return [a.x, a.y, a.z] }
  // machine (ClientMachine.js) is the single source of truth for editor on/off, gizmo mode, selection.
  let selectedEntityId = null, gizmoGroup = null, minimapOverlayMesh = null
  // waypoint-viewport-drag-path-visualization: persistent path-line overlay through ordered waypoint
  // entities, refreshed from the same live SCENE_GRAPH entity list app.js's editor-frame-update node
  // already threads through (updateWaypointPath below) -- see WaypointPath.js's own header comment for
  // why direct viewport drag is NOT a separate bespoke gizmo (the existing generic one already covers it
  // once an entity is selected).
  const waypointPath = createWaypointPathOverlay({ scene, entityMeshes })
  let _lastSceneEntities = []
  // extraSelectedIds: shift/ctrl-clicked siblings that ride along on batch move/rotate/scale/delete; selectedEntityId stays primary.
  const extraSelectedIds = new Set()
  let dragAxis = null, dragStart = null, dragEntityStart = null, _dragBeforeState = null
  // Radius-drag state (trigger-volume-radius-gizmo-handle): dragAxis==='radius' is a distinct drag
  // kind from translate/rotate/scale -- it reads world-space distance from the entity's own position
  // to the current mouse ray's ground-plane intersection, not an axis-projected delta, so it gets its
  // own start-state pair rather than overloading dragStart/dragEntityStart (which are THREE.Vector3
  // world points / entity-transform snapshots, wrong shape for a scalar radius).
  let _dragRadiusStart = null, _dragRadiusCenter = null
  let _extraDragStart = null   // Map<id, Vector3|Quaternion> per extra-selected mesh at drag start
  let _onChange = null, _onTransformCommit = null, _onEditModeChange = null, _onDragUpdate = null, _onGizmoSpaceChange = null, _onPivotModeChange = null, _onPlaytestStart = null, _onPlaytestStop = null, _onCommandPalette = null
  // Scatter-place (editor-multi-place-drag): armed by the Add menu (Shift-click an item) with a
  // placeFn(hitPoint) callback; the next empty-space viewport drag places a copy every SCATTER_STEP
  // world units travelled along the drag path instead of doing a normal camera-look empty-drag.
  const SCATTER_STEP = 2
  let _scatterPlaceFn = null, _scatterActive = false, _scatterLastPoint = null, _scatterCount = 0
  const editMode = () => machine.isEditor
  function _mode() { return machine.gizmoMode }
  const raycaster = new THREE.Raycaster()
  const _plane = new THREE.Plane()
  // Set true in onStart whenever the current drag uses the closest-point-to-axis-line technique
  // (scale/rotate/local-translate, see onStart's plane-vs-axis-line comment) instead of a plane
  // intersection -- applyGizmoDrag's per-move-frame sampling must reuse the SAME technique the
  // drag started with, or the delta comparison mixes two different coordinate derivations.
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

  // Radius-drag handle (trigger-volume-radius-gizmo-handle): a flat horizontal ring at the entity's
  // Y position, radius matching custom.radius, shown ADDITIONALLY alongside whichever translate/
  // rotate/scale gizmo is currently active -- not a 4th gizmoMode, since a radius-shaped entity still
  // wants normal move/rotate/scale on its position/transform too. Separate group (radiusGizmoGroup)
  // so it survives independently of gizmoGroup's per-mode rebuild in _buildGizmo/attachGizmo.
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
  // Rebuild the ring geometry at a new radius (drag-live-update) without tearing down/rebuilding the
  // whole group every mousemove frame -- cheap enough (torus + 4 spheres) that a full rebuild here is
  // fine, unlike gizmoGroup's translate/rotate/scale handles which stay fixed-size.
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
    // Centroid pivot with an active multi-selection: the gizmo handle itself moves to the shared
    // center rather than the primary entity's own position (individual/active both keep it on the
    // primary -- individual still needs a single drag-plane anchor, it just doesn't orbit members).
    gizmoGroup.position.copy(_pivotMode === 'centroid' && extraSelectedIds.size ? _computeCentroid([id, ...extraSelectedIds]) : mesh.position)
    scene.add(gizmoGroup)
    // Radius handle only for a single-select primary (no defined "shared radius drag" for a
    // multi-select batch yet, matching the pre-existing single-entity-only scope of most gizmo drags).
    if (!extraSelectedIds.size) attachRadiusGizmo(mesh)
  }

  // A single-entity select (hierarchy row click, HookFlow node click, or any other caller not
  // itself managing a multi-select batch) exits multi-select mode by default: clearing
  // extraSelectedIds keeps the gizmo's shared-pivot batch-drag state and the inspector's
  // single-vs-multi view in sync with each other, instead of the gizmo silently staying batched
  // while the inspector already dropped back to showing one entity. Viewport box-select is the one
  // caller that legitimately populates extraSelectedIds BEFORE picking a primary and calling this
  // (see _finishBoxSelect) -- it passes preserveExtras:true so its own freshly-built batch survives.
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
    // changes.position (when present) is always built from a RENDER-space mesh.position.toArray()/
    // .set() by every caller of this function (commitGizmoDrag, the nudge handler, paste, and app.js's
    // numeric-field/custom-field inspector handler) -- convert to AUTHORITATIVE local-frame meters here,
    // the single choke point every one of those callers already funnels through, before it crosses the
    // network boundary via MSG.EDITOR_UPDATE. onCommitEdit (app.js's _recordPendingEdit) must receive the
    // SAME authoritative value: it stashes changes.position to override the next wire snapshot's
    // e.position (also authoritative, see app.js's onStateUpdate _pendingEdits comparison) until the
    // server's own EDITOR_UPDATE ack lands, so a render-space value there would never match and the
    // pending-edit guard would silently never engage past the first rebase.
    if (Array.isArray(changes.position)) changes = { ...changes, position: _authArr({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }) }
    // onCommitEdit records the optimistic pending edit so a stale snapshot can't snap the gizmo move back.
    if (onCommitEdit) try { onCommitEdit(selectedEntityId, changes) } catch (_) {}
    client.send(MSG.EDITOR_UPDATE, { entityId: selectedEntityId, changes })
  }

  // editor-copy-paste-entity: clipboard holds {position,rotation,scale,custom} snapshotted from
  // whichever entity was selected at Ctrl+C time; Ctrl+V applies it onto the CURRENTLY selected
  // entity (which may be a different one) via the same EDITOR_UPDATE path the inspector uses.
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
    // Undo-tracked (editor-undo-transactionality): capture `before` from the mesh's OWN current state
    // ahead of the overwrite, mirroring commitGizmoDrag's _dragBeforeState -- without this, Ctrl+V was
    // silently unrevertable via Ctrl+Z (the only mutation path that bypassed EditHistory entirely).
    const before = { position: mesh.position.toArray(), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: JSON.parse(JSON.stringify(mesh.userData.custom || {})) }
    const changes = { position: _clipboard.position.slice(), rotation: _clipboard.rotation.slice(), scale: _clipboard.scale.slice(), custom: JSON.parse(JSON.stringify(_clipboard.custom)) }
    mesh.position.fromArray(changes.position)
    mesh.quaternion.fromArray(changes.rotation)
    mesh.scale.fromArray(changes.scale)
    mesh.userData.custom = JSON.parse(JSON.stringify(changes.custom))
    if (gizmoGroup) gizmoGroup.position.copy(mesh.position)
    // changes.position is RENDER-space (just written straight into mesh.position above, and kept that
    // way for _onTransformCommit's undo/redo record below, which writes it back into mesh.position on a
    // Ctrl+Z/jump-to-history -- see EditHistory.js). The WIRE send needs the AUTHORITATIVE conversion
    // (same reasoning as sendEditorUpdate above), so build a separate wire-only copy rather than mutating
    // `changes` itself.
    const wireChanges = Array.isArray(changes.position) ? { ...changes, position: _authArr({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }) } : changes
    if (onCommitEdit) try { onCommitEdit(selectedEntityId, wireChanges) } catch (_) {}
    client.send(MSG.EDITOR_UPDATE, { entityId: selectedEntityId, changes: wireChanges })
    if (_onTransformCommit) _onTransformCommit({ entityId: selectedEntityId, before, after: changes, kind: 'paste' })
    return true
  }

  const _AX = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) }
  let _tapStartX = 0, _tapStartY = 0, _dragMoved = false
  // 'world' (default) uses fixed world-space X/Y/Z axes; 'local' rotates them by the selected entity's current quaternion.
  let _gizmoSpace = 'world'
  // Multi-select pivot mode (editor-multiselect-pivot-options): 'active' (default, back-compat) --
  // the gizmo stays on the primary selectedEntityId, extras rotate/scale as a rigid group riding the
  // primary's own delta. 'centroid' -- gizmo sits at the selection's geometric center; rotate/scale
  // orbit every member (primary included) around that shared point. 'individual' -- each entity
  // rotates/scales about its OWN origin (position untouched by rotate/scale); translate is always a
  // uniform world-space delta regardless of pivot mode, since translation has no pivot dependence.
  let _pivotMode = 'active'
  const _PIVOT_MODES = ['active', 'centroid', 'individual']
  // Snapshot of every selected mesh's position at drag start, keyed by id (primary included), used
  // only by centroid/individual pivot math -- kept separate from dragEntityStart/_extraDragStart
  // (which snapshot the DRAGGED value: position for translate, quaternion for rotate, scale for
  // scale) since centroid/individual need every member's STARTING POSITION regardless of drag mode.
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
    // Re-snap the gizmo handle position immediately (not just on next select/attach) so switching
    // into/out of centroid mode while something is already selected is visibly instant.
    if (selectedEntityId && !dragAxis) attachGizmo(selectedEntityId)
  }

  function pickEntity(e) {
    // Locked entities (client-side-only SceneHierarchy flag) are excluded from the viewport pick list so they
    // can't be gizmo-selected/dragged by accident; they remain selectable directly from the hierarchy panel
    // (SceneHierarchy's own row click calls selectEntity via onSelect, bypassing this raycast entirely).
    const meshList = []; entityMeshes.forEach((mesh, id) => { if (mesh.userData?.isEditable && !(isLocked && isLocked(id))) meshList.push({ mesh, id }) })
    const hits = raycaster.intersectObjects(meshList.map(m => m.mesh), true)
    if (!hits.length) return null
    const found = meshList.find(m => m.mesh.getObjectById ? m.mesh.getObjectById(hits[0].object.id) : m.mesh === hits[0].object)
    if (!found) return null
    const mesh = found.mesh
    // ent.position is displayed AND forwarded to the app-maker onSelect API surface (see app.js's
    // _editorAPIBundle._emitSelect(id, data)) -- authoritative, matching _buildEntityData's conversion,
    // not the raw render-space mesh.position.
    return { id: found.id, ent: { id: found.id, position: _authArr(mesh.position), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} } }
  }

  // Modifier-key precision drag: shift = fine (0.1x), alt = coarse (10x). Applied as a scale on the drag delta magnitude.
  const PRECISION_FINE = 0.1
  const PRECISION_COARSE = 10
  function _precisionScale(e) { return e.shiftKey ? PRECISION_FINE : e.altKey ? PRECISION_COARSE : 1 }
  // Angle-snap increment (degrees) applied to rotate-gizmo drags while grid-snap (machine.snapOn) is on.
  const ROTATE_SNAP_DEG = 15

  // Snap-to-entity (editor-snap-to-entity): candidate snap points are every OTHER selectable entity's
  // world-space bbox center + 8 corners + 6 face-midpoints. World-space threshold (not screen-space) so
  // the snap "pull" scales naturally with camera zoom the same way the existing grid-snap does.
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

  // Radius drag: horizontal-plane (world XZ at the entity's Y) ray intersection -> distance from the
  // entity's own position IS the new radius. No axis constraint (unlike translate/scale/rotate) since
  // a radius is inherently a scalar magnitude, not a directional component -- dragging any of the 4
  // handles or the ring itself in any direction reads the same "how far is the mouse from center" value.
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
    // Must resample with the SAME technique onStart used to compute dragStart (see onStart's
    // plane-vs-axis-line comment) -- mixing a plane-intersection dragStart with an axis-line pt (or
    // vice versa) would compare two different coordinate derivations and produce a bogus delta.
    // editor-gizmo-rotate-line-axis-fix: rotate's line runs along projAxis (perpendicular to
    // dragAxis), matching onStart's _lineAxisForDrag -- see that comment for why.
    let pt
    if (_dragUsesAxisLine) {
      const lineAxis = _mode() === 'rotate' ? (dragAxis === 'x' ? 'y' : 'x') : dragAxis
      pt = _closestPointOnAxisLine(raycaster.ray, gizmoGroup.position, _axisVec(lineAxis))
    } else {
      pt = new THREE.Vector3(); raycaster.ray.intersectPlane(_plane, pt); if (!pt) return
    }
    const delta = pt.clone().sub(dragStart).multiplyScalar(_precisionScale(e))
    const mesh = entityMeshes.get(selectedEntityId); if (!mesh) return
    // Centroid pivot point at drag start (only computed/used when _pivotMode === 'centroid' and a
    // multi-selection is active -- _dragPositionStart is only populated in that case, see onStart).
    const _centroidPivot = (_pivotMode === 'centroid' && _dragPositionStart) ? _computeCentroid(_dragPositionStart.keys()) : null
    if (_mode() === 'scale') {
      const s = dragEntityStart.clone()
      const d = delta.dot(_axisVec(dragAxis))
      if (dragAxis==='x') s.x = Math.max(0.01, s.x + d)
      else if (dragAxis==='y') s.y = Math.max(0.01, s.y + d)
      else s.z = Math.max(0.01, s.z + d)
      mesh.scale.copy(s)
      // Centroid pivot also moves the primary's own position away from/toward the shared center as
      // its scale grows/shrinks (a true "scale about the group center"); active/individual leave
      // every member's position untouched, matching the pre-pivot-mode behavior exactly.
      if (_centroidPivot) {
        const startPos = _dragPositionStart.get(selectedEntityId)
        const offset = startPos.clone().sub(_centroidPivot)
        // Guard against a zero starting-scale component (degenerate but reachable via manual inspector
        // entry) -- a divide-by-zero factor would otherwise poison offset with Infinity/NaN.
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
      // Each ring's projection axis must differ from its own rotation axis, or the drag response is wrong.
      const projAxis = dragAxis==='x'?'y':'x'
      let d = delta.dot(_axisVec(projAxis))
      // Angle-snap (editor-gizmo-angle-snap): reuses the same snap toggle as translate/grid-snap.
      // d is the cumulative angle (radians) from drag start, so rounding it directly to a fixed
      // step (not a delta-from-delta) keeps the snapped angle stable regardless of pointer jitter.
      if (machine.snapOn) {
        const stepDeg = ROTATE_SNAP_DEG
        const stepRad = stepDeg * Math.PI / 180
        d = Math.round(d / stepRad) * stepRad
      }
      const rotAxis = _axisVec(dragAxis)
      const q = new THREE.Quaternion().setFromAxisAngle(rotAxis, d)
      mesh.quaternion.copy(dragEntityStart.clone()).multiply(q)
      // Centroid pivot: orbit the primary's position around the shared center by the same angle,
      // same as a real DCC "rotate about median point". Active/individual (the pre-pivot-mode
      // default) leave every member's position untouched -- each entity spins about its own origin.
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
      // Snap the delta from drag start, not absolute world coords, or a non-grid-aligned entity teleports on the first nudge.
      let snapDx = 0, snapDy = 0, snapDz = 0
      if (machine.snapOn) {
        const sz=machine.snapSize
        snapDx=Math.round((newPos.x-dragEntityStart.x)/sz)*sz - (newPos.x-dragEntityStart.x)
        snapDy=Math.round((newPos.y-dragEntityStart.y)/sz)*sz - (newPos.y-dragEntityStart.y)
        snapDz=Math.round((newPos.z-dragEntityStart.z)/sz)*sz - (newPos.z-dragEntityStart.z)
        newPos.x+=snapDx; newPos.y+=snapDy; newPos.z+=snapDz
      }
      // Snap-to-surface: while dragging the Y axis with Ctrl held and grid-snap off, raycast straight down at the
      // entity's new XZ position and pin Y to whatever geometry is hit (terrain or another entity).
      if (dragAxis === 'y' && e.ctrlKey && !machine.snapOn && raycastHitPoint) {
        const surfaceHit = raycastHitPoint(e.clientX, e.clientY)
        if (surfaceHit) newPos.y = surfaceHit.y
      }
      // Snap-to-entity (editor-snap-to-entity): with grid-snap off and Ctrl not held (Ctrl is reserved for
      // Y surface-snap above), pull the dragged position onto the nearest OTHER selectable entity's bbox
      // corner/center/edge-midpoint within SNAP_TO_ENTITY_THRESHOLD world units. Any axis of translate drag.
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
    // Centroid pivot moves POSITION alongside rotation/scale (orbit-about-shared-center, see
    // applyGizmoDrag) -- include it in the committed changes so the server-authoritative snapshot
    // doesn't snap the orbited entities back to their pre-drag position on the next tick.
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
        // changes stays RENDER-space for the _onTransformCommit undo record below (same reasoning as
        // sendEditorUpdate/pasteOntoSelectedEntity) -- the wire send gets its own authoritative-converted copy.
        const wireChanges = Array.isArray(changes.position) ? { ...changes, position: _authArr({ x: changes.position[0], y: changes.position[1], z: changes.position[2] }) } : changes
        if (onCommitEdit) try { onCommitEdit(eid, wireChanges) } catch (_) {}
        client.send(MSG.EDITOR_UPDATE, { entityId: eid, changes: wireChanges })
        // Push an undo/redo record for each extra-selected member too (mirrors the primary's _onTransformCommit
        // call above) -- without this, a multi-select batch drag was only ever undoable for the primary entity,
        // silently leaving every other dragged entity's transform unrevertable via Ctrl+Z. EditHistory's
        // BATCH_WINDOW_MS coalescing groups this with the primary's push (same commitGizmoDrag tick) into one
        // undoable unit, so a single Ctrl+Z reverts the whole batch, not just one member.
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

  // Empty-space left-click-drag drives camera look, same as right-button drag.
  let _emptyDragActive = false, _emptyLastX = 0, _emptyLastY = 0
  // Marquee box-select: shift/ctrl + drag on empty space (plain empty-drag stays camera-look, no gesture conflict).
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
      // preserveExtras: the batch this function just built into extraSelectedIds (above) must survive
      // selectEntity's default single-select clear -- this is a real multi-select, not a plain pick.
      selectEntity(primary, mesh ? { id: primary, position: _authArr(mesh.position), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} } : null, { preserveExtras: true })
    } else if (_onChange) _onChange(selectedEntityId, null)
  }
  const _ptrDrag = C.usePointerDrag ? C.usePointerDrag(renderer.domElement, {
    onStart(e) {
      if (!editMode() || (e.button != null && e.button !== 0)) return false
      _tapStartX = e.clientX; _tapStartY = e.clientY; _dragMoved = false
      raycaster.setFromCamera(getNDC(e), camera)
      // Radius-handle hit test runs BEFORE the mode gizmo's own hit test: the radius ring sits at the
      // same world position as the translate gizmo's origin, and a maker reaching for the outer ring
      // (further from center than any translate/scale handle's unit-length reach) should hit the
      // radius drag, not fall through to empty-space camera-look.
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
          // World-space translate reads the full 2D delta vector directly (drag-plane extent IS the
          // response), so it needs the camera-facing plane (normal = viewDir x axis, merely CONTAINS
          // the axis, oriented toward the camera) for a well-conditioned free 2-axis drag.
          //
          // Every other case (scale always; rotate always; local-space translate) reads only
          // delta.dot(<the axis actually being measured>) -- a SINGLE-axis-constrained response. A
          // plane-intersection approach is fundamentally the wrong tool here: EVERY plane choice
          // (camera-facing OR the axis's own plane) goes degenerate for some camera angle -- camera-
          // facing collapses whenever the view direction is steep relative to the axis (e.g. Y-axis
          // with the camera pitched down: normal collapses to ~world-X, nearly parallel to a vertical
          // mouse-drag ray -- live-reproduced, a 6000px drag moved a rotate ring under 0.5 degrees);
          // the axis's OWN plane collapses in the opposite case, when the camera sits near-level with
          // the target (ray nearly grazes a horizontal Y-plane -- live-reproduced, intersectPlane
          // returned the exact same degenerate point for every mouse position, freezing scale at 300px
          // of drag). Fix: closest-point-to-the-AXIS-LINE (not a plane at all) -- for two skew lines
          // (the mouse ray and a world line through the gizmo), the closest point on that line to the
          // ray is well-conditioned for any camera angle except the ray running exactly parallel to the
          // line itself (a real edge case no plane-based approach solves either, and far rarer than
          // "camera near-level with target" or "camera pitched steeply").
          //
          // editor-gizmo-rotate-line-axis-fix: scale/local-translate build the line along dragAxis
          // because applyGizmoDrag's response for those modes is delta.dot(_axisVec(dragAxis)) --
          // the SAME axis, so constraining pt to that line preserves 100% of the measured component.
          // Rotate is different: applyGizmoDrag measures delta.dot(_axisVec(projAxis)), a PERPENDICULAR
          // axis to dragAxis (by design, see applyGizmoDrag's own comment) -- building the line along
          // dragAxis therefore constrains pt to have almost ZERO component along projAxis (any two
          // points on a line have no displacement perpendicular to that line), so delta.dot(projAxisVec)
          // reads ~0 regardless of real mouse movement and the ring never visibly rotates. Live-witnessed
          // via a real Playwright drag + a THREE.Quaternion.setFromAxisAngle monkeypatch: dragging 300px
          // across the Y ring produced angle:0 on every call. Fix: build rotate's line along projAxis
          // instead, so the closest-point response varies exactly along the axis rotate's math reads.
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
          // Revert the live-mutated mesh.userData.custom.radius + ring size back to the pre-drag value --
          // a cancelled drag must leave zero trace, matching commitGizmoDrag's cancel branch below for translate/rotate/scale.
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

  // Gated to edit mode: FileDropLoader handles non-edit drops, running both would double-place.
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
    // Stagger multi-file placements along the forward axis to avoid stacking/z-fight.
    let i = 0
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file)
      showToast(STRINGS.editorUploadingFile(file.name))
      try {
        const res = await fetch('/upload-model', { method: 'POST', body: fd })
        if (!res.ok) { showToast(STRINGS.editorUploadFailed(res.status === 413 ? 'file too large' : res.status === 400 ? 'invalid model' : 'server error'), 'error'); continue }
        const { url } = await res.json()
        const step = i * 1.5
        // dropPoint is a RENDER-space raycast hit (raycastHitPoint hits scene.children, see app.js's
        // _raycastHitPoint); local.position is already AUTHORITATIVE (server-echoed playerStates). Both
        // branches must land in the same (authoritative) space before crossing MSG.PLACE_MODEL's network
        // boundary, or a drag-drop placed past the first rebase lands near the render-space origin
        // instead of where the cursor actually pointed.
        const pos = dropPoint
          ? _authArr({ x: dropPoint.x + Math.sin(baseYaw) * step, y: dropPoint.y, z: dropPoint.z + Math.cos(baseYaw) * step })
          : local
          ? [local.position[0] + Math.sin(baseYaw) * (2 + step), local.position[1], local.position[2] + Math.cos(baseYaw) * (2 + step)]
          : [0, 0, 2 + step]
        client.send(MSG.PLACE_MODEL, { url, position: pos })
        showToast(STRINGS.editorFilePlaced(file.name))
        i++
      } catch (err) { console.error('[editor] upload failed:', err.message); showToast(STRINGS.editorUploadFailed(err.message), 'error') }
    }
  }
  document.addEventListener("dragover", _onDragOver)
  document.addEventListener("dragleave", _onDragLeave)
  document.addEventListener('drop', _onDrop)
  // touchAction 'none' while editing so page scroll/zoom doesn't steal a coarse-pointer gizmo drag; restores prior value on exit.
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

  // Minimap ground-plane reference overlay (minimap-hud-editor-ui-integration): a flat textured plane
  // showing the same baked top-down PNG the HUD widget uses, for level-design orientation while editing.
  // window.__minimapMeta (set in app.js's onWorldDef, mirrors the window.__terrain/window.__floatingOrigin
  // cross-module-read convention -- createEditor has no direct worldDef access) carries {base,center,extent}.
  // Positioning uses spoint's ordinary LOCAL x/y/z directly -- same space every entity/gizmo in this file
  // already uses (see AGENTS.md floating-origin-camera-relative-rendering row: gameplay objects are
  // positioned with the raw local-frame x/y/z, not mapspinner's separate planet-ECEF world space that
  // PlanetFrame.localToWorld projects into) -- so this does NOT need localToWorld/east/north/up rotation,
  // just a flat XZ-plane sized `extent` and centered at `center`, translated by floatingOrigin.toRender
  // so it stays correctly positioned across a planetary-range rebase.
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
    geo.rotateX(-Math.PI / 2) // PlaneGeometry is XY by default; rotate flat onto the ground's XZ plane
    const mesh = new THREE.Mesh(geo, mat)
    mesh.renderOrder = -1 // draws under gizmos/entities, never fights their depth at a coplanar Y
    const authX = meta.center[0], authZ = meta.center[1]
    let groundY = 0
    try { const f = window.__terrain && window.__terrain.frame; if (f) groundY = f.groundHeightLocal(authX, authZ) } catch (_) {}
    const fo = window.__floatingOrigin
    if (fo) { const r = fo.toRender({ x: authX, y: groundY + 0.05, z: authZ }); mesh.position.copy(r) }
    else mesh.position.set(authX, groundY + 0.05, authZ) // +0.05: sits just above ground, avoids z-fighting with terrain
    scene.add(mesh)
    minimapOverlayMesh = mesh
    return true
  }

  return {
    onKeyDown(e) {
      // Bare P only: Alt+P is reserved for the pivot-mode cycle below (editor-multiselect-pivot-options)
      // -- without excluding modifiers here, Alt+P would ALSO match this bare check first and exit
      // edit mode before the pivot-cycle branch (gated on editMode()) ever got a chance to run.
      if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        machine.send('TOGGLE_EDITOR')
      }
      // Ctrl+Shift+P: command palette (in-editor only)
      if (e.code === 'KeyP' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        if (e.cancelable) e.preventDefault()
        if (_onCommandPalette) _onCommandPalette()
        return
      }
      // Ctrl+Shift+T: playtest (in-editor play/pause/eject)
      if (e.code === 'KeyT' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
        if (e.cancelable) e.preventDefault()
        if (machine.isPlaytesting) {
          if (_onPlaytestStop) _onPlaytestStop()
        } else if (editMode()) {
          if (_onPlaytestStart) _onPlaytestStart()
        }
        return
      }
      // Camera bookmarks: Ctrl+Alt+1..9 saves the current edit-camera pose to slot N,
      // Alt+1..9 (no Ctrl) recalls it. Only active while the editor is actually open --
      // plain Alt+digit outside the editor is left alone for whatever else might use it.
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
        // W/E/R alias the standard Blender/Unity translate/rotate/scale mnemonics for the toolbar's
        // IconButtonGroup, alongside the pre-existing G/R/Alt+S bindings (kept for back-compat).
        // Bare 'R' historically means rotate here (not the W/E/R convention's own R=scale) --
        // both KeyR paths below intentionally agree (rotate), so there is no conflict to resolve.
        if ((e.code === 'KeyG' || e.code === 'KeyW') && !e.ctrlKey && !e.metaKey && !e.altKey) { if (e.cancelable) e.preventDefault(); machine.send('TRANSLATE'); if (selectedEntityId) attachGizmo(selectedEntityId); else showToast(STRINGS.editorNoEntitySelected) }
        if ((e.code === 'KeyR' || e.code === 'KeyE') && !e.ctrlKey && !e.metaKey && !e.altKey) { if (e.cancelable) e.preventDefault(); machine.send('ROTATE'); if (selectedEntityId) attachGizmo(selectedEntityId); else showToast(STRINGS.editorNoEntitySelected) }
        // Alt+S not bare S: bare S is the fly-camera's backward key.
        if (e.code === 'KeyS' && e.altKey && !e.ctrlKey && !e.metaKey) { if (e.cancelable) e.preventDefault(); machine.send('SCALE'); if (selectedEntityId) attachGizmo(selectedEntityId); else showToast(STRINGS.editorNoEntitySelected) }
        // editor-gizmo-local-world-toggle: bare Y (unused elsewhere in the editor scope -- WASDC/QE
        // drive the fly-camera, this only fires while editMode() is true) toggles world/local drag axes.
        if (e.code === 'KeyY' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.cancelable) e.preventDefault()
          setGizmoSpace(_gizmoSpace === 'local' ? 'world' : 'local')
          if (_onGizmoSpaceChange) _onGizmoSpaceChange(_gizmoSpace)
          showToast('Gizmo space: ' + _gizmoSpace)
        }
        // editor-multiselect-pivot-options: Alt+P cycles active -> centroid -> individual -> active.
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
            // Frame the entity's actual bounding sphere, preserving the camera's current viewing direction.
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
        // editor-copy-paste-entity: Ctrl+C copies the selected entity's transform+custom props;
        // Ctrl+V pastes them onto whatever is CURRENTLY selected (may be a different entity).
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
        // Arrow keys nudge X/Z (top-down convention), PageUp/Down nudge Y, one snap step or 0.25 default.
        const _nudgeKeys = { ArrowLeft: [-1,0,0], ArrowRight: [1,0,0], ArrowUp: [0,0,-1], ArrowDown: [0,0,1], PageUp: [0,1,0], PageDown: [0,-1,0] }
        if (_nudgeKeys[e.code] && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (!selectedEntityId) { return }
          if (e.cancelable) e.preventDefault()
          const mesh = entityMeshes.get(selectedEntityId); if (!mesh) return
          const step = machine.snapOn ? machine.snapSize : 0.25
          const [dx, dy, dz] = _nudgeKeys[e.code]
          // Undo-tracked (editor-undo-transactionality): a nudge was previously the only gizmo-adjacent
          // move NOT pushed to editHistory -- capture `before` first so Ctrl+Z can revert it, same shape
          // as commitGizmoDrag's primary+extra push pair (both land in this one synchronous handler call,
          // so EditHistory's BATCH_WINDOW_MS coalescing groups them into a single undoable unit).
          const _nudgeBefore = { position: mesh.position.toArray() }
          mesh.position.x += dx * step; mesh.position.y += dy * step; mesh.position.z += dz * step
          if (gizmoGroup) gizmoGroup.position.copy(mesh.position)
          sendEditorUpdate({ position: mesh.position.toArray() })
          if (_onTransformCommit) _onTransformCommit({ entityId: selectedEntityId, before: _nudgeBefore, after: { position: mesh.position.toArray() }, kind: 'nudge' })
          for (const eid of extraSelectedIds) {
            const em = entityMeshes.get(eid); if (!em) continue
            const _nudgeBeforeExtra = { position: em.position.toArray() }
            em.position.x += dx * step; em.position.y += dy * step; em.position.z += dz * step
            // wireChanges: authoritative-converted copy for onCommitEdit/the wire send; _onTransformCommit's
            // undo record below stays render-space (matches _nudgeBeforeExtra and every other undo record).
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
        // onDestroyEntities (app.js's _structDestroy per id) routes the delete through the editor's
        // undo history; the bare client.send fallback keeps the delete working even when unwired.
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
      // waypoint-viewport-drag-path-visualization: refresh the path-line every frame (cheap no-op via
      // WaypointPath.js's own change-detection key when nothing moved) so a live gizmo drag of a
      // waypoint marker -- including the EARLY-RETURN case just below, e.g. while dragAxis is set and
      // the rest of this function is skipped -- is still reflected in the line's shape immediately, not
      // only after the drag commits and a fresh SCENE_GRAPH round-trip arrives.
      if (_lastSceneEntities.length) waypointPath.update(_lastSceneEntities, selectedEntityId)
      if (!gizmoGroup || !selectedEntityId || dragAxis) return
      const m = entityMeshes.get(selectedEntityId); if (!m) return
      gizmoGroup.position.copy(_pivotMode === 'centroid' && extraSelectedIds.size ? _computeCentroid([selectedEntityId, ...extraSelectedIds]) : m.position)
      // Radius gizmo follows the entity's position too (e.g. after a translate-gizmo move commits
      // and re-attaches, or a nudge/paste moves the entity) -- keep it visually pinned to the entity,
      // not stuck at its position from the moment it was first attached.
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
    // waypoint-viewport-drag-path-visualization: rebuilds the path-line overlay from the live entity
    // list (no-ops if unchanged since last call, see WaypointPath.js's _pointsKey change-detection).
    // Called from EditorShell.updateScene on every SCENE_GRAPH push (caches the list into
    // _lastSceneEntities for the per-frame refresh below) AND internally every frame via updateGizmo()
    // (part of app.js's editor-frame-update node) using that cached list crossed with LIVE entityMeshes
    // positions -- this is what makes the line visually track a waypoint being gizmo-dragged in
    // real time, not just update on the next server round-trip. Passes the CURRENT selectedEntityId so
    // the in-scene order label highlight always matches the timeline panel's own highlighted row.
    updateWaypointPath(entities) { _lastSceneEntities = entities || []; waypointPath.update(_lastSceneEntities, selectedEntityId) },
    // app.js reads this to suppress the authoritative snapshot position-reset for the dragged entity (snap-back fix).
    isDragging() { return dragAxis !== null },
    get selectedEntityId() { return selectedEntityId },
    get gizmoMode() { return _mode() },
    setGizmoSpace,
    get gizmoSpace() { return _gizmoSpace },
    setPivotMode,
    get pivotMode() { return _pivotMode },
    // editor-multi-place-drag: arm scatter-place mode. placeFn(THREE.Vector3 hitPoint) is called once
    // per SCATTER_STEP world units of drag travel on the next empty-space viewport mousedown+drag.
    armScatterPlace(placeFn) { _scatterPlaceFn = typeof placeFn === 'function' ? placeFn : null },
    get scatterArmed() { return !!_scatterPlaceFn },
    // editor-copy-paste-entity: exposed for a context-menu Copy/Paste pair (SceneHierarchy) as well
    // as the Ctrl+C/Ctrl+V keybinding above.
    copySelectedEntity,
    pasteOntoSelectedEntity,
    get hasClipboard() { return !!_clipboard },
    // Playtest mode: start/stop callbacks set by app.js.
    onPlaytestStart(fn) { _onPlaytestStart = fn },
    onPlaytestStop(fn) { _onPlaytestStop = fn },
    onCommandPalette(fn) { _onCommandPalette = fn }
  }
}