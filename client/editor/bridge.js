import { PhysicsNetworkClient } from '/src/index.client.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export function connectEditorToGame(editor, THREE) {
  const gltfLoader = new GLTFLoader()
  const playerMeshes = new Map()
  const entityMeshes = new Map()

  const liveGroup = new THREE.Group()
  liveGroup.name = 'Game Scene (Live)'
  editor.addObject(liveGroup)

  const playersGroup = new THREE.Group()
  playersGroup.name = 'Players'
  liveGroup.add(playersGroup)

  const entitiesGroup = new THREE.Group()
  entitiesGroup.name = 'Entities'
  liveGroup.add(entitiesGroup)

  editor.signals.sceneGraphChanged.dispatch()

  const client = new PhysicsNetworkClient({
    url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    predictionEnabled: false,
    onStateUpdate(state) {
      for (const p of state.players) {
        let mesh = playerMeshes.get(p.id)
        if (!mesh) {
          mesh = new THREE.Group()
          mesh.name = `Player_${p.id}`
          const capsule = new THREE.Mesh(
            new THREE.CapsuleGeometry(0.3, 1.0, 8, 16),
            new THREE.MeshStandardMaterial({ color: 0x4488ff })
          )
          capsule.name = 'Capsule'
          capsule.position.y = 0.8
          mesh.add(capsule)
          playersGroup.add(mesh)
          playerMeshes.set(p.id, mesh)
          editor.signals.sceneGraphChanged.dispatch()
        }
        mesh.position.set(p.position[0], p.position[1] - 1.3, p.position[2])
        if (p.rotation) mesh.quaternion.set(p.rotation[0], p.rotation[1], p.rotation[2], p.rotation[3])
      }
      const activeIds = new Set(state.players.map(p => p.id))
      for (const [id, mesh] of playerMeshes) {
        if (!activeIds.has(id)) {
          playersGroup.remove(mesh)
          playerMeshes.delete(id)
          editor.signals.sceneGraphChanged.dispatch()
        }
      }
      editor.signals.objectChanged.dispatch(liveGroup)
    },
    onEntityAdded(id, entityState) {
      if (entityState.model) {
        const url = entityState.model.startsWith('./') ? '/' + entityState.model.slice(2) : entityState.model
        gltfLoader.load(url, (gltf) => {
          const model = gltf.scene
          model.name = `Entity_${id}`
          model.position.set(...entityState.position)
          if (entityState.rotation) model.quaternion.set(...entityState.rotation)
          entitiesGroup.add(model)
          entityMeshes.set(id, model)
          editor.signals.sceneGraphChanged.dispatch()
        })
      } else {
        const c = entityState.custom || {}
        const geo = c.mesh === 'sphere' ? new THREE.SphereGeometry(c.r || 0.5) :
                    c.mesh === 'cylinder' ? new THREE.CylinderGeometry(c.r || 0.4, c.r || 0.4, c.h || 0.1) :
                    new THREE.BoxGeometry(c.sx || 1, c.sy || 1, c.sz || 1)
        const mat = new THREE.MeshStandardMaterial({ color: c.color ?? 0xff8800 })
        const mesh = new THREE.Mesh(geo, mat)
        mesh.name = `Entity_${id}`
        mesh.position.set(...entityState.position)
        if (entityState.rotation) mesh.quaternion.set(...entityState.rotation)
        entitiesGroup.add(mesh)
        entityMeshes.set(id, mesh)
        editor.signals.sceneGraphChanged.dispatch()
      }
    },
    onEntityRemoved(id) {
      const mesh = entityMeshes.get(id)
      if (mesh) {
        entitiesGroup.remove(mesh)
        entityMeshes.delete(id)
        editor.signals.sceneGraphChanged.dispatch()
      }
    },
    onWorldDef(wd) {
      if (wd.scene) {
        if (wd.scene.skyColor != null) editor.scene.background = new THREE.Color(wd.scene.skyColor)
        if (wd.scene.fogColor != null) editor.scene.fog = new THREE.Fog(wd.scene.fogColor, wd.scene.fogNear ?? 80, wd.scene.fogFar ?? 200)
        editor.signals.sceneBackgroundChanged.dispatch()
      }
    },
    onPlayerLeft(id) {
      const mesh = playerMeshes.get(id)
      if (mesh) {
        playersGroup.remove(mesh)
        playerMeshes.delete(id)
        editor.signals.sceneGraphChanged.dispatch()
      }
    },
    onHotReload() {}
  })

  client.connect().then(() => console.log('[editor-bridge] Connected to game server'))

  window.gameClient = client
  window.liveGroup = liveGroup
}
