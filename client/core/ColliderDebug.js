// Debug wireframe of the physics terrain collider (Jolt heightfield), toggled via ?drawcollider or C. window.__colliderDebug = { toggle, setVisible, update, dispose, visible }.
// Must mirror the server's heightfield grid exactly (extent/resolution/corner/re-center) or the drawn grid won't match what Jolt actually collides against.
import * as THREE from 'three'

// Entity collider overlay: draws render geometry as a wireframe proxy (exact for trimesh, approximate for box/sphere/capsule primitives).
function createEntityColliderOverlay(scene) {
  const group = new THREE.Group()
  group.visible = false
  group.renderOrder = 9998
  scene.add(group)
  const overlays = new Map()
  const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 })

  function sync(entityMeshes) {
    if (!group.visible) return
    for (const [id, mesh] of entityMeshes) {
      if (overlays.has(id)) continue
      const seg = new THREE.Group()
      mesh.traverse(c => {
        if (!c.isMesh || !c.geometry) return
        const wf = new THREE.LineSegments(new THREE.WireframeGeometry(c.geometry), mat)
        wf.matrixAutoUpdate = false
        seg.add(wf)
        seg.userData.follow = seg.userData.follow || []
        seg.userData.follow.push([wf, c])
      })
      group.add(seg)
      overlays.set(id, seg)
    }
    for (const id of overlays.keys()) {
      if (!entityMeshes.has(id)) { const seg = overlays.get(id); group.remove(seg); overlays.delete(id) }
    }
    for (const seg of overlays.values()) {
      for (const [wf, src] of (seg.userData.follow || [])) { src.updateWorldMatrix(true, false); wf.matrix.copy(src.matrixWorld); wf.matrixWorldNeedsUpdate = true }
    }
  }

  function setVisible(v) {
    group.visible = !!v
    if (!v) { for (const seg of overlays.values()) group.remove(seg); overlays.clear() }
  }
  function dispose() { setVisible(false); scene.remove(group); mat.dispose() }
  return { sync, setVisible, dispose, get visible() { return group.visible } }
}

export function createColliderDebug({ scene, frame, cfg }) {
  if (!scene || !frame) return { toggle() {}, setVisible() {}, update() {}, dispose() {}, get visible() { return false } }
  const phys = (cfg && cfg.physics) || {}
  const extent = Number.isFinite(phys.extent) && phys.extent > 0 ? phys.extent : 256
  const resolution = Number.isFinite(phys.resolution) && phys.resolution > 0 ? phys.resolution : 2
  let N = Math.max(2, Math.round(extent / resolution)); if (N % 2 !== 0) N += 1
  const spacing = extent / (N - 1)
  const rebuildAt = 0.4   // must match the server streamer's re-center hysteresis

  const segCount = 2 * N * (N - 1)
  const positions = new Float32Array(segCount * 2 * 3)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.LineBasicMaterial({ color: 0xff00ff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 })
  const lines = new THREE.LineSegments(geo, mat)
  lines.frustumCulled = false
  lines.renderOrder = 9999
  lines.visible = false
  scene.add(lines)

  let curCenterX = NaN, curCenterZ = NaN

  function _rebuild(cx, cz) {
    const cornerX = cx - extent / 2, cornerZ = cz - extent / 2
    const H = new Float32Array(N * N)
    for (let z = 0; z < N; z++) {
      const wz = cornerZ + z * spacing, row = z * N
      for (let x = 0; x < N; x++) {
        let h = frame.groundHeightLocal(cornerX + x * spacing, wz)
        if (!Number.isFinite(h)) h = -1000   // mirrors server NaN guard
        H[row + x] = h
      }
    }
    let o = 0
    const put = (x, z) => { positions[o++] = cornerX + x * spacing; positions[o++] = H[z * N + x]; positions[o++] = cornerZ + z * spacing }
    for (let z = 0; z < N; z++) for (let x = 0; x < N - 1; x++) { put(x, z); put(x + 1, z) }
    for (let z = 0; z < N - 1; z++) for (let x = 0; x < N; x++) { put(x, z); put(x, z + 1) }
    geo.attributes.position.needsUpdate = true
    geo.computeBoundingSphere()
    curCenterX = cx; curCenterZ = cz
  }

  const entityOverlay = createEntityColliderOverlay(scene)

  function update(playerPos, entityMeshes) {
    if (entityMeshes) entityOverlay.sync(entityMeshes)
    if (!lines.visible) return
    let px, pz
    if (playerPos && Array.isArray(playerPos.position)) { px = playerPos.position[0]; pz = playerPos.position[2] }
    else if (Array.isArray(playerPos)) { px = playerPos[0]; pz = playerPos[2] }
    else if (playerPos && Number.isFinite(playerPos.x)) { px = playerPos.x; pz = playerPos.z }
    if (!Number.isFinite(px) || !Number.isFinite(pz)) { px = 0; pz = 0 }
    if (!Number.isFinite(curCenterX) || Math.hypot(px - curCenterX, pz - curCenterZ) > extent * rebuildAt) _rebuild(px, pz)
  }

  function setVisible(v) { lines.visible = !!v; entityOverlay.setVisible(v); if (v && !Number.isFinite(curCenterX)) _rebuild(0, 0) }
  function toggle() { setVisible(!lines.visible) }
  function dispose() { try { scene.remove(lines); geo.dispose(); mat.dispose(); entityOverlay.dispose() } catch (_) {} }

  const api = { toggle, setVisible, update, dispose, get visible() { return lines.visible }, _lines: lines, N, spacing, extent }
  if (typeof window !== 'undefined') window.__colliderDebug = api
  return api
}
