const ASSET_BASE = 'https://raw.githubusercontent.com/anEntrypoint/assets/main'

const JUNK_MODELS = [
  `${ASSET_BASE}/dumpster_b076662a_v1.glb`,
  `${ASSET_BASE}/garbage_can_6b3d052b_v1.glb`,
  `${ASSET_BASE}/fire_hydrant_ba0175c1_v1.glb`,
  `${ASSET_BASE}/crushed_oil_barrel_e450f43f_v1.glb`,
]

const HALF = 12
const WALL_H = 3
const WALL_T = 0.5

const WALLS = [
  { id: 'arena-wall-n', x: 0,     y: WALL_H / 2, z: -HALF,  hx: HALF,        hy: WALL_H / 2, hz: WALL_T / 2 },
  { id: 'arena-wall-s', x: 0,     y: WALL_H / 2, z:  HALF,  hx: HALF,        hy: WALL_H / 2, hz: WALL_T / 2 },
  { id: 'arena-wall-e', x:  HALF, y: WALL_H / 2, z: 0,      hx: WALL_T / 2, hy: WALL_H / 2, hz: HALF },
  { id: 'arena-wall-w', x: -HALF, y: WALL_H / 2, z: 0,      hx: WALL_T / 2, hy: WALL_H / 2, hz: HALF },
]

const PROPS = [
  { model: 0, x: -6, z: -6, rot: 0.5 },
  { model: 0, x:  7, z:  5, rot: 2.1 },
  { model: 1, x: -8, z:  3, rot: 1.0 },
  { model: 1, x:  5, z: -7, rot: 3.2 },
  { model: 1, x:  3, z:  8, rot: 0.3 },
  { model: 2, x: -4, z: -9, rot: 1.5 },
  { model: 2, x:  9, z: -3, rot: 4.0 },
  { model: 3, x: -7, z:  7, rot: 0.8 },
  { model: 3, x:  6, z:  2, rot: 2.7 },
  { model: 3, x: -3, z: -5, rot: 1.2 },
]

export default {
  server: {
    setup(ctx) {
      ctx.state.ids = ctx.state.ids || []
      if (ctx.state.ids.length > 0) return

      // Ground (this entity itself)
      ctx.entity.custom = { mesh: 'box', color: 0x5a7a4a, roughness: 1, sx: HALF * 2, sy: 0.5, sz: HALF * 2 }
      ctx.physics.setStatic(true)
      ctx.physics.addBoxCollider([HALF, 0.25, HALF])

      // Walls - each gets box-static app which adds its own collider
      for (const w of WALLS) {
        const e = ctx.world.spawn(w.id, {
          position: [w.x, w.y, w.z],
          app: 'box-static',
          config: { hx: w.hx, hy: w.hy, hz: w.hz, color: 0x7a6a5a, roughness: 0.9 }
        })
        if (e) ctx.state.ids.push(w.id)
      }

      // Props from remote asset repo (static, convex hull from model)
      for (let i = 0; i < PROPS.length; i++) {
        const p = PROPS[i]
        const id = `arena-prop-${i}`
        const a = p.rot / 2
        const e = ctx.world.spawn(id, {
          model: JUNK_MODELS[p.model],
          position: [p.x, 0, p.z],
          rotation: [0, Math.sin(a), 0, Math.cos(a)],
          app: 'prop-static'
        })
        if (e) ctx.state.ids.push(id)
      }

      ctx.debug.log(`[arena] setup: ground + ${WALLS.length} walls + ${PROPS.length} props`)
    },

    teardown(ctx) {
      for (const id of ctx.state.ids || []) ctx.world.destroy(id)
      ctx.state.ids = []
    }
  },

  client: {
    render(ctx) {
      return { position: ctx.entity.position, rotation: ctx.entity.rotation, custom: ctx.entity.custom }
    }
  }
}
