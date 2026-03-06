import * as THREE from 'three'
import { MSG } from '/src/protocol/MessageTypes.js'

export function createEditor({ scene, camera, renderer, client, entityMeshes, playerStates, inspector }) {
  let selectedEntityId = null, gizmoEnabled = false, gizmoGroup = null
  let dragAxis = null, dragStart = null, dragEntityStart = null
  const raycaster = new THREE.Raycaster()
  const _plane = new THREE.Plane()

  function buildGizmo() {
    const g = new THREE.Group()
    g.userData.isGizmo = true
    for (const [axis, color, rx, rz] of [['x',0xff2222,0,-Math.PI/2],['y',0x22ff22,0,0],['z',0x2222ff,Math.PI/2,0]]) {
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false })
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 8), mat)
      shaft.geometry.translate(0, 0.5, 0)
      shaft.rotation.x = rx; shaft.rotation.z = rz
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

  function attachGizmo(id) {
    if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }
    const mesh = entityMeshes.get(id); if (!mesh) return
    gizmoGroup = buildGizmo(); gizmoGroup.position.copy(mesh.position); scene.add(gizmoGroup)
  }

  function toggleGizmo() {
    if (!selectedEntityId) return
    gizmoEnabled = !gizmoEnabled
    if (gizmoEnabled) attachGizmo(selectedEntityId)
    else { if (gizmoGroup) { scene.remove(gizmoGroup); gizmoGroup = null }; gizmoEnabled = false }
  }

  function selectEntity(id) {
    selectedEntityId = id; if (gizmoGroup) attachGizmo(id)
  }

  function sendEditorUpdate(changes) {
    if (selectedEntityId) client.send(MSG.EDITOR_UPDATE, { entityId: selectedEntityId, changes })
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

  inspector.onChange((key, value) => {
    if (key === 'collider') sendEditorUpdate({ custom: { _collider: value } })
    else if (key.startsWith('custom.')) sendEditorUpdate({ custom: { [key.slice(7)]: value } })
    else if (key === '_rotEuler') sendEditorUpdate({ rotation: eulerDegToQuat(value) })
    else { sendEditorUpdate({ [key]: value }); if (key === 'position' && gizmoGroup) gizmoGroup.position.fromArray(value) }
  })

  renderer.domElement.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    raycaster.setFromCamera(getNDC(e), camera)
    if (gizmoGroup) {
      const hits = raycaster.intersectObjects(gizmoGroup.children, false)
      if (hits.length > 0) {
        dragAxis = hits[0].object.userData.gizmoAxis
        const mesh = entityMeshes.get(selectedEntityId)
        dragEntityStart = mesh ? mesh.position.clone() : new THREE.Vector3()
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
      if (found) { selectEntity(found.id); inspector.show({ id: found.id, position: found.mesh.position.toArray(), rotation: [0,0,0,1], scale: found.mesh.scale.toArray(), custom: found.mesh.userData.custom || {} }) }
    }
  })

  window.addEventListener('mousemove', e => {
    if (!dragAxis || !dragStart || !gizmoGroup) return
    raycaster.setFromCamera(getNDC(e), camera)
    const pt = new THREE.Vector3(); raycaster.ray.intersectPlane(_plane, pt); if (!pt) return
    const delta = pt.clone().sub(dragStart), newPos = dragEntityStart.clone()
    if (dragAxis==='x') newPos.x += delta.x; else if (dragAxis==='y') newPos.y += delta.y; else newPos.z += delta.z
    gizmoGroup.position.copy(newPos); const mesh = entityMeshes.get(selectedEntityId); if (mesh) mesh.position.copy(newPos)
  })

  window.addEventListener('mouseup', () => {
    if (!dragAxis) return
    const mesh = entityMeshes.get(selectedEntityId); if (mesh) sendEditorUpdate({ position: mesh.position.toArray() })
    dragAxis = null; dragStart = null; dragEntityStart = null
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
    toggleGizmo, selectEntity,
    onKeyDown(e) { if (e.code === 'KeyP') toggleGizmo() },
    updateGizmo() { if (gizmoGroup && selectedEntityId) { const m = entityMeshes.get(selectedEntityId); if (m && !dragAxis) gizmoGroup.position.copy(m.position) } }
  }
}
