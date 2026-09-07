// DecalSystem -- pooled projected decals (bullet holes / scorch marks) + hitscan tracers.
//
// Roadmap items #48 (decals) + tracer half of #93 (shooter feel). A fixed-size ring of pre-allocated
// THREE.Mesh decal quads is reused round-robin so firing never allocates -- the same pooling discipline
// as ModelPool/InstancedMesh2 elsewhere in this codebase. Each decal is a small plane oriented to the
// hit normal, offset along the normal to avoid z-fighting with the surface it's stuck to, and faded out
// via opacity over its lifetime rather than instant despawn (matches roadmap's 'per-surface limits').
//
// Tracers are a separate pool of thin stretched-box meshes (cheap, no line-material AA issues), spawned
// from a shot origin toward its impact point (or full range if no hit), and faded/removed after a short
// lifetime.

const DECAL_POOL_SIZE = 64
const DECAL_LIFETIME_S = 12
const DECAL_FADE_S = 2
const DECAL_SIZE = 0.22

const TRACER_POOL_SIZE = 24
const TRACER_LIFETIME_S = 0.09
const TRACER_RADIUS = 0.012

export function createDecalSystem(scene, THREE) {
  const decalGeo = new THREE.PlaneGeometry(1, 1)
  const decalMat = new THREE.MeshBasicMaterial({
    color: 0x1a1512, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  })
  const decals = []
  for (let i = 0; i < DECAL_POOL_SIZE; i++) {
    const m = new THREE.Mesh(decalGeo, decalMat.clone())
    m.visible = false
    m.renderOrder = 10
    m.matrixAutoUpdate = false   // pooled: transform set once per spawn (updateMatrix there), not recomposed every frame for 64 mostly-invisible meshes
    scene.add(m)
    decals.push({ mesh: m, age: Infinity, life: DECAL_LIFETIME_S })
  }
  let _nextDecal = 0

  const tracerGeo = new THREE.BoxGeometry(1, 1, 1)
  const tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.9, depthWrite: false })
  const tracers = []
  for (let i = 0; i < TRACER_POOL_SIZE; i++) {
    const m = new THREE.Mesh(tracerGeo, tracerMat.clone())
    m.visible = false
    m.renderOrder = 11
    m.matrixAutoUpdate = false
    scene.add(m)
    tracers.push({ mesh: m, age: Infinity })
  }
  let _nextTracer = 0

  const _up = new THREE.Vector3(0, 1, 0)
  const _q = new THREE.Quaternion()
  const _normal = new THREE.Vector3()

  return {
    // point: [x,y,z] world-space impact position. normal: [x,y,z] surface normal (defaults to +Y if omitted --
    // the server hit payload doesn't carry a surface normal today, only the impact point).
    spawnDecal(point, normal) {
      if (!point) return
      const slot = decals[_nextDecal]; _nextDecal = (_nextDecal + 1) % DECAL_POOL_SIZE
      _normal.set(normal ? normal[0] : 0, normal ? normal[1] : 1, normal ? normal[2] : 0)
      if (_normal.lengthSq() < 1e-6) _normal.set(0, 1, 0)
      _normal.normalize()
      _q.setFromUnitVectors(_up, _normal)
      slot.mesh.position.set(point[0] + _normal.x * 0.01, point[1] + _normal.y * 0.01, point[2] + _normal.z * 0.01)
      slot.mesh.quaternion.copy(_q)
      slot.mesh.rotation.z = Math.random() * Math.PI * 2 // vary orientation in-plane so a decal cluster isn't identical
      const s = DECAL_SIZE * (0.8 + Math.random() * 0.4)
      slot.mesh.scale.set(s, s, s)
      slot.mesh.updateMatrix()
      slot.mesh.material.opacity = 0.85
      slot.mesh.visible = true
      slot.age = 0
      slot.life = DECAL_LIFETIME_S
    },

    // origin/target: [x,y,z] world-space. Draws a short-lived stretched box from origin to target.
    spawnTracer(origin, target) {
      if (!origin || !target) return
      const slot = tracers[_nextTracer]; _nextTracer = (_nextTracer + 1) % TRACER_POOL_SIZE
      const dx = target[0] - origin[0], dy = target[1] - origin[1], dz = target[2] - origin[2]
      const len = Math.hypot(dx, dy, dz)
      if (len < 1e-4) return
      slot.mesh.position.set((origin[0] + target[0]) / 2, (origin[1] + target[1]) / 2, (origin[2] + target[2]) / 2)
      _normal.set(dx / len, dy / len, dz / len)
      _q.setFromUnitVectors(_up, _normal)
      slot.mesh.quaternion.copy(_q)
      slot.mesh.scale.set(TRACER_RADIUS, len, TRACER_RADIUS)
      slot.mesh.updateMatrix()
      slot.mesh.material.opacity = 0.9
      slot.mesh.visible = true
      slot.age = 0
    },

    tick(dt) {
      for (let i = 0; i < DECAL_POOL_SIZE; i++) {
        const d = decals[i]
        if (!d.mesh.visible) continue
        d.age += dt
        if (d.age >= d.life) { d.mesh.visible = false; continue }
        const fadeStart = d.life - DECAL_FADE_S
        if (d.age > fadeStart) d.mesh.material.opacity = 0.85 * Math.max(0, 1 - (d.age - fadeStart) / DECAL_FADE_S)
      }
      for (let i = 0; i < TRACER_POOL_SIZE; i++) {
        const t = tracers[i]
        if (!t.mesh.visible) continue
        t.age += dt
        if (t.age >= TRACER_LIFETIME_S) { t.mesh.visible = false; continue }
        t.mesh.material.opacity = 0.9 * Math.max(0, 1 - t.age / TRACER_LIFETIME_S)
      }
    },

    dispose() {
      for (const d of decals) { scene.remove(d.mesh); d.mesh.material.dispose() }
      for (const t of tracers) { scene.remove(t.mesh); t.mesh.material.dispose() }
      decalGeo.dispose(); decalMat.dispose(); tracerGeo.dispose(); tracerMat.dispose()
    },
  }
}
