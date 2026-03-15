import * as THREE from 'three'

function createGimbal(scale = 1) {
  const gimbal = new THREE.Group()
  const lineGeom = new THREE.BufferGeometry()
  lineGeom.setFromPoints([new THREE.Vector3(-scale, 0, 0), new THREE.Vector3(scale, 0, 0), new THREE.Vector3(0, -scale, 0), new THREE.Vector3(0, scale, 0), new THREE.Vector3(0, 0, -scale), new THREE.Vector3(0, 0, scale)])
  gimbal.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.6 })))
  for (const r of [{ rot: [Math.PI / 2, 0, 0], color: 0xff0000 }, { rot: [0, Math.PI / 2, 0], color: 0x00ff00 }, { rot: [0, 0, 0], color: 0x0000ff }]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(scale * 0.9, scale * 0.08, 16, 100), new THREE.MeshBasicMaterial({ color: r.color, transparent: true, opacity: 0.5 }))
    ring.rotation.fromArray(r.rot); gimbal.add(ring)
  }
  gimbal.userData.isGimbal = true; return gimbal
}

export function createFileDropLoader(scene, gltfLoader, cam, playerStates, appModules, engineCtx) {
  const modelLoadQueue = []

  function loadQueuedModels() {
    if (modelLoadQueue.length === 0) return
    const file = modelLoadQueue.shift()
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        gltfLoader.parse(e.target.result, '', (gltf) => {
          const local = playerStates.get(engineCtx.playerId)
          if (!local) return
          const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw)
          const x = local.position[0] + sy, y = local.position[1] + (local.crouch ? 1.1 : 1.6) + 0.3, z = local.position[2] + cy
          const group = new THREE.Group()
          if (gltf.scene) group.add(gltf.scene)
          group.add(Object.assign(createGimbal(0.5), { position: group.position.clone() }))
          group.position.set(x, y, z); group.userData.isDroppedModel = true; scene.add(group)
          const envApp = appModules.get('environment')
          if (envApp?.onEvent) envApp.onEvent({ type: 'dropModel', position: [x, y, z], rotation: [0, 0, 0, 1], modelPath: file.name, scale: [1, 1, 1] }, engineCtx)
          setTimeout(loadQueuedModels, 100)
        }, (err) => { console.error('[ModelLoader] Parse error:', err.message); setTimeout(loadQueuedModels, 100) })
      } catch (err) { console.error('[ModelLoader] Load error:', err.message); setTimeout(loadQueuedModels, 100) }
    }
    reader.readAsArrayBuffer(file)
  }

  function setupDropListeners(rendererDomElement) {
    document.addEventListener('dragover', (e) => { if (!cam.getEditMode()) return; e.preventDefault(); e.stopPropagation(); rendererDomElement.style.opacity = '0.8' })
    document.addEventListener('dragleave', () => { if (!cam.getEditMode()) return; rendererDomElement.style.opacity = '1' })
    document.addEventListener('drop', (e) => {
      if (!cam.getEditMode()) return; e.preventDefault(); e.stopPropagation(); rendererDomElement.style.opacity = '1'
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const f = e.dataTransfer.files[i]
        if (f.type === 'model/gltf-binary' || f.type === 'model/gltf+json' || f.name.endsWith('.glb') || f.name.endsWith('.gltf')) modelLoadQueue.push(f)
      }
      if (modelLoadQueue.length > 0) loadQueuedModels()
    })
  }

  return { setupDropListeners }
}
