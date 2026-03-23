import * as THREE from 'three'
import { MSG } from '/src/protocol/MessageTypes.js'

export let editMode = false
let _onEditModeChange = null, _snapEnabled = false, _snapSize = 0.25
export function setSnap(enabled, size) { _snapEnabled = enabled; if (size !== undefined) _snapSize = size }

export function createEditor({ scene, camera, renderer, client, entityMeshes, playerStates }) {
  let selectedEntityId = null, gizmoGroup = null
  let dragAxis = null, dragStart = null, dragEntityStart = null, _dragBeforeState = null
  let _onChange = null, _gizmoMode = 'translate', _onTransformCommit = null
  const raycaster = new THREE.Raycaster()
  const _plane = new THREE.Plane()

  function buildTranslateGizmo() {
    const g = new THREE.Group(); g.userData.isGizmo = true; g.userData.mode = 'translate'
    for (const [axis, color, rx, rz] of [['x',0xff2222,0,-Math.PI/2],['y',0x22ff22,0,0],['z',0x2222ff,Math.PI/2,0]]) {
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false })
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 8), mat)
      shaft.geometry.translate(0, 0.5, 0); shaft.rotation.x = rx; shaft.rotation.z = rz
      shaft.userData.gizmoAxis = axis; shaft.renderOrder = 999
      const cap = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.25, 8), mat)
      cap.geometry.translate(0, 0.125, 0)
      if (axis === 'x') { cap.rotation.z = -Math.PI/2; cap.position.set(1, 0, 0) }
      else if (axis === 'y') cap.position.set(0, 1, 0)
      else { cap.rotation.x = Math.PI/2; cap.position.set(0, 0, 1) }
      cap.userData.gizmoAxis = axis; cap.renderOrder = 999
      g.add(shaft); g.add(cap)
    }
    return g
  }

  function buildRotateGizmo() {
    const g = new THREE.Group(); g.userData.isGizmo = true; g.userData.mode = 'rotate'
    for (const [axis,color,rx,ry] of [['x',0xff2222,0,Math.PI/2],['y',0x22ff22,Math.PI/2,0],['z',0x2222ff,0,0]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1,0.04,8,32),new THREE.MeshBasicMaterial({color,depthTest:false,side:THREE.DoubleSide}))
      ring.rotation.x=rx;ring.rotation.y=ry;ring.userData.gizmoAxis=axis;ring.renderOrder=999;g.add(ring)
    }
    return g
  }

  function buildScaleGizmo() {
    const g = new THREE.Group(); g.userData.isGizmo = true; g.userData.mode = 'scale'
    for (const [axis,color,rx,rz,px,py,pz] of [['x',0xff2222,0,-Math.PI/2,1,0,0],['y',0x22ff22,0,0,0,1,0],['z',0x2222ff,Math.PI/2,0,0,0,1]]) {
      const mat=new THREE.MeshBasicMaterial({color,depthTest:false})
      const shaft=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.04,1,8),mat);shaft.geometry.translate(0,0.5,0);shaft.rotation.x=rx;shaft.rotation.z=rz;shaft.userData.gizmoAxis=axis;shaft.renderOrder=999
      const box=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.2,0.2),mat);box.position.set(px,py,pz);box.userData.gizmoAxis=axis;box.renderOrder=999
      g.add(shaft);g.add(box)
    }
    return g
  }

  function _buildGizmo() { return _gizmoMode==='rotate'?buildRotateGizmo():_gizmoMode==='scale'?buildScaleGizmo():buildTranslateGizmo() }

  function attachGizmo(id) {
    if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
    if (!editMode) return
    const mesh = entityMeshes.get(id); if (!mesh) return
    gizmoGroup = _buildGizmo(); gizmoGroup.position.copy(mesh.position); scene.add(gizmoGroup)
  }

  function selectEntity(id, entityData) {
    selectedEntityId = id
    if (editMode) attachGizmo(id)
    if (_onChange) _onChange(id, entityData)
  }

  function eulerDegToQuat([ex, ey, ez]) {
    const [rx,ry,rz] = [ex*Math.PI/180, ey*Math.PI/180, ez*Math.PI/180]
    const cx=Math.cos(rx/2),sx=Math.sin(rx/2),cy=Math.cos(ry/2),sy=Math.sin(ry/2),cz=Math.cos(rz/2),sz=Math.sin(rz/2)
    return [cx*sy*sz+sx*cy*cz, cx*cy*sz-sx*sy*cz, cx*sy*cz-sx*cy*sz, cx*cy*cz+sx*sy*sz]
  }

  function getNDC(e) {
    const r = renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX-r.left)/r.width)*2-1, -((e.clientY-r.top)/r.height)*2+1)
  }

  function sendEditorUpdate(changes) {
    if (selectedEntityId) client.send(MSG.EDITOR_UPDATE, { entityId: selectedEntityId, changes })
  }

  renderer.domElement.addEventListener('mousedown', e => {
    if (e.button !== 0 || !editMode) return
    raycaster.setFromCamera(getNDC(e), camera)
    if (gizmoGroup) {
      const hits = raycaster.intersectObjects(gizmoGroup.children, false)
      if (hits.length > 0) {
        dragAxis = hits[0].object.userData.gizmoAxis
        const mesh = entityMeshes.get(selectedEntityId)
        dragEntityStart = _gizmoMode === 'scale' ? (mesh ? mesh.scale.clone() : new THREE.Vector3(1,1,1)) : (mesh ? mesh.position.clone() : new THREE.Vector3())
        _dragBeforeState = _gizmoMode === 'scale' ? { scale: mesh.scale.toArray() } : _gizmoMode === 'rotate' ? { rotation: mesh.quaternion.toArray() } : { position: mesh.position.toArray() }
        const axVec = dragAxis==='x' ? new THREE.Vector3(1,0,0) : dragAxis==='y' ? new THREE.Vector3(0,1,0) : new THREE.Vector3(0,0,1)
        _plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).cross(axVec).normalize(), gizmoGroup.position)
        const pt = new THREE.Vector3(); raycaster.ray.intersectPlane(_plane, pt); dragStart = pt
        e.stopPropagation(); return
      }
    }
    const meshList = []; entityMeshes.forEach((mesh, id) => { if (mesh.userData?.isEditable) meshList.push({ mesh, id }) })
    const hits2 = raycaster.intersectObjects(meshList.map(m => m.mesh), true)
    if (hits2.length > 0) {
      const found = meshList.find(m => m.mesh.getObjectById ? m.mesh.getObjectById(hits2[0].object.id) : m.mesh === hits2[0].object)
      if (found) {
        const mesh = found.mesh
        const ent = { id: found.id, position: mesh.position.toArray(), rotation: mesh.quaternion.toArray(), scale: mesh.scale.toArray(), custom: mesh.userData.custom || {} }
        selectEntity(found.id, ent)
      }
    }
  })

  window.addEventListener('mousemove', e => {
    if (!dragAxis || !dragStart || !gizmoGroup) return
    raycaster.setFromCamera(getNDC(e), camera)
    const pt = new THREE.Vector3(); raycaster.ray.intersectPlane(_plane, pt); if (!pt) return
    const delta = pt.clone().sub(dragStart)
    const mesh = entityMeshes.get(selectedEntityId); if (!mesh) return
    if (_gizmoMode === 'scale') {
      const s = dragEntityStart.clone()
      const d = delta.dot(dragAxis==='x'?new THREE.Vector3(1,0,0):dragAxis==='y'?new THREE.Vector3(0,1,0):new THREE.Vector3(0,0,1))
      if (dragAxis==='x') s.x = Math.max(0.01, s.x + d)
      else if (dragAxis==='y') s.y = Math.max(0.01, s.y + d)
      else s.z = Math.max(0.01, s.z + d)
      mesh.scale.copy(s)
    } else if (_gizmoMode === 'rotate') {
      const d = delta.dot(dragAxis==='x'?new THREE.Vector3(0,1,0):dragAxis==='y'?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0))
      const q = new THREE.Quaternion()
      q.setFromAxisAngle(dragAxis==='x'?new THREE.Vector3(1,0,0):dragAxis==='y'?new THREE.Vector3(0,1,0):new THREE.Vector3(0,0,1), d)
      mesh.quaternion.copy(dragEntityStart.clone()).multiply(q)
    } else {
      const newPos = dragEntityStart.clone()
      if (dragAxis==='x') newPos.x += delta.x; else if (dragAxis==='y') newPos.y += delta.y; else newPos.z += delta.z
      if (_snapEnabled) { newPos.x=Math.round(newPos.x/_snapSize)*_snapSize; newPos.y=Math.round(newPos.y/_snapSize)*_snapSize; newPos.z=Math.round(newPos.z/_snapSize)*_snapSize }
      gizmoGroup.position.copy(newPos); mesh.position.copy(newPos)
    }
  })

  window.addEventListener('mouseup', () => {
    if (!dragAxis) return
    const mesh = entityMeshes.get(selectedEntityId)
    if (mesh) {
      if (_gizmoMode === 'scale') sendEditorUpdate({ scale: mesh.scale.toArray() })
      else if (_gizmoMode === 'rotate') sendEditorUpdate({ rotation: mesh.quaternion.toArray() })
      else sendEditorUpdate({ position: mesh.position.toArray() })
      if (_onTransformCommit && _dragBeforeState) {
        const after = _gizmoMode==='scale' ? { scale: mesh.scale.toArray() } : _gizmoMode==='rotate' ? { rotation: mesh.quaternion.toArray() } : { position: mesh.position.toArray() }
        _onTransformCommit({ entityId: selectedEntityId, before: _dragBeforeState, after, kind: _gizmoMode })
      }
    }
    dragAxis = null; dragStart = null; dragEntityStart = null; _dragBeforeState = null
  })

  document.addEventListener('dragover', e => { e.preventDefault(); renderer.domElement.style.outline = '3px solid #4af' })
  document.addEventListener('dragleave', () => { renderer.domElement.style.outline = '' })
  document.addEventListener('drop', async e => {
    e.preventDefault(); renderer.domElement.style.outline = ''
    for (const file of [...e.dataTransfer.files].filter(f => f.name.endsWith('.glb') || f.name.endsWith('.gltf'))) {
      const fd = new FormData(); fd.append('file', file)
      try {
        const { url } = await fetch('/upload-model', { method: 'POST', body: fd }).then(r => r.json())
        const local = playerStates.get(client.playerId)
        const pos = local ? [local.position[0]+Math.sin(local.yaw||0)*2, local.position[1], local.position[2]+Math.cos(local.yaw||0)*2] : [0,0,2]
        client.send(MSG.PLACE_MODEL, { url, position: pos })
      } catch (err) { console.error('[editor] upload failed:', err.message) }
    }
  })

  return {
    onKeyDown(e) {
      if (e.code === 'KeyP') {
        editMode = !editMode
        if (!editMode && gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
        if (editMode && selectedEntityId) attachGizmo(selectedEntityId)
        if (_onEditModeChange) _onEditModeChange(editMode)
      }
      if (editMode) {
        if (e.code === 'KeyG') { _gizmoMode = 'translate'; if (selectedEntityId) attachGizmo(selectedEntityId) }
        if (e.code === 'KeyR') { _gizmoMode = 'rotate'; if (selectedEntityId) attachGizmo(selectedEntityId) }
        if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) { _gizmoMode = 'scale'; if (selectedEntityId) attachGizmo(selectedEntityId) }
        if (e.code === 'KeyF' && selectedEntityId) {
          const mesh = entityMeshes.get(selectedEntityId)
          if (mesh) { camera.position.set(mesh.position.x, mesh.position.y + 2, mesh.position.z + 5); camera.lookAt(mesh.position) }
        }
      }
      if (e.code === 'Delete' && editMode && selectedEntityId) {
        client.send(MSG.DESTROY_ENTITY, { entityId: selectedEntityId })
        if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
        selectedEntityId = null
        if (_onChange) _onChange(null, null)
      }
    },
    onSelectionChange(fn) { _onChange = fn },
    onEditModeChange(fn) { _onEditModeChange = fn },
    onTransformCommit(cb) { _onTransformCommit = cb },
    sendEditorUpdate,
    eulerDegToQuat,
    selectEntity,
    updateGizmo() { if (gizmoGroup && selectedEntityId) { const m = entityMeshes.get(selectedEntityId); if (m && !dragAxis) gizmoGroup.position.copy(m.position) } },
    get selectedEntityId() { return selectedEntityId },
    get gizmoMode() { return _gizmoMode }
  }
}
