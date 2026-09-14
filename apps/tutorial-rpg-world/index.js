import { TUTORIAL_BUS } from '../_lib/tutorial-rpg-kit.js'

const FLOOR_TOP_Y = 0.5
const HERB_GROVE_CENTER = [30, 20]
const HERB_COUNT = 10

const RESPAWN_SECONDS = { 'tutorial-rat': 8, 'tutorial-herb': 12, 'tutorial-boss': 30 }

const ratAt = (id, x, z) => ({ id, app: 'tutorial-rat', bodyType: 'dynamic', position: [x, FLOOR_TOP_Y + 0.2, z] })

const herbAt = (i) => {
  const angle = (i / HERB_COUNT) * Math.PI * 2
  const ring = 3 + (i % 2) * 3
  return { id: `herb-${i}`, app: 'tutorial-herb', position: [HERB_GROVE_CENTER[0] + Math.cos(angle) * ring, FLOOR_TOP_Y + 0.3, HERB_GROVE_CENTER[1] + Math.sin(angle) * ring], config: { itemId: 'herb' } }
}

const LAYOUT = [
  { id: 'elder', app: 'tutorial-npc', position: [-4, FLOOR_TOP_Y + 0.9, 20], config: { npcId: 'elder', name: 'Elder', color: 0xc9a36b } },
  { id: 'healer', app: 'tutorial-npc', position: [4, FLOOR_TOP_Y + 0.9, 20], config: { npcId: 'healer', name: 'Healer', color: 0x8fd18f } },
  ratAt('rat-1', -22, 12),
  ratAt('rat-2', -28, 14),
  ratAt('rat-3', -25, 18),
  ratAt('rat-4', -20, 17),
  ratAt('rat-5', -30, 10),
  ...Array.from({ length: HERB_COUNT }, (_, i) => herbAt(i)),
  { id: 'shrine-marker', app: 'tutorial-marker', position: [-35, FLOOR_TOP_Y + 0.03, -35], config: { marker: 'shrine', name: 'Forest Shrine', radius: 4 } },
  { id: 'shadow-beast', app: 'tutorial-boss', bodyType: 'dynamic', position: [40, FLOOR_TOP_Y + 1.15, -5] },
]

export default {
  server: {
    setup(ctx) {
      const entryById = new Map(LAYOUT.map(entry => [entry.id, entry]))
      const spawn = (entry) => ctx.world.spawnChild(entry.id, { app: entry.app, bodyType: entry.bodyType, position: [...entry.position], config: entry.config ?? {} })
      const retireAndRespawn = ({ data }) => {
        const entry = entryById.get(data?.entityId)
        if (!entry) return
        ctx.world.destroy(entry.id)
        ctx.time.after(RESPAWN_SECONDS[entry.app], () => { if (!ctx.world.getEntity(entry.id)) spawn(entry) })
      }
      ctx.bus.on(TUTORIAL_BUS.kill, retireAndRespawn)
      ctx.bus.on(TUTORIAL_BUS.collect, retireAndRespawn)
      for (const entry of LAYOUT) spawn(entry)
    },
  },
}
