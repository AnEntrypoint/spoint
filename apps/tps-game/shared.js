import { rayVsCapsule, hitHeightRatio, normalizeShotDirection, DEFAULT_HITBOX } from '../../src/netcode/Hitscan.js'

export const POWERUP_DEFS = [
  { type: 'damage', color: 0xff3344, emissive: 0xaa0000, buff: { duration: 20, speedMultiplier: 1, fireRateMultiplier: 1, damageMultiplier: 2 } },
  { type: 'speed', color: 0x33aaff, emissive: 0x0044aa, buff: { duration: 20, speedMultiplier: 1.5, fireRateMultiplier: 1, damageMultiplier: 1 } },
  { type: 'rapid', color: 0xffcc33, emissive: 0xaa6600, buff: { duration: 20, speedMultiplier: 1, fireRateMultiplier: 2, damageMultiplier: 1 } },
]
export const COMBAT_CONFIG = {
  respawnTime: 1.5,
  health: 100,
  damagePerHit: 20,
  headshotMultiplier: 2.5,
  headshotZone: 0.7,
  hitKnockback: 4,
  shootKnockback: 2,
  magazineSize: 30,
  reloadTime: 2000,
  spawnInvulnMs: 1500
}

export const POWERUP_RESPAWN_MS = 15000
export const FIRE_SPEC = {
  radius: 63600,
  role: 'authority',
  stepTicks: 30,
  seed: 1337,
  leadTicks: 6,
  regrowSteps: 1200,
  classes: {
    grass: { fuel: 3000, burnRate: 1500, igniteHeat: 90, heatOut: 500, spotChance: 0, spotHeat: 0, smoke: 40, damage: 6 },
    shrub: { fuel: 12000, burnRate: 2000, igniteHeat: 170, heatOut: 800, spotChance: 40, spotHeat: 400, smoke: 90, damage: 10 },
    forest: { fuel: 45000, burnRate: 2500, igniteHeat: 600, heatOut: 1200, spotChance: 120, spotHeat: 700, smoke: 160, damage: 16 },
  },
  gameplay: { damageEveryTicks: 15, statusDamagePerSec: 6, burnStatusSeconds: 4, smokeBlockDepth: 1, smokeHeightM: 30, eyeHeightM: 1.6, explosionImpulse: 12 },
  firebreaks: { kinds: ['road', 'river'], water: true },
}
const PREDICT_RANGE_M = 1000
const DEFAULT_HEADSHOT_ZONE = 0.7

const EMOTES = Object.freeze({
  wave: { label: 'Bow', clip: 'Bow' },
  dance: { label: 'Dance', clip: 'DanceLoop' },
  nod: { label: 'Nod', clip: 'HeadNod' },
  victory: { label: 'Victory', clip: 'Victory' },
  meditate: { label: 'Meditate', clip: 'Meditate' },
  jumpingjacks: { label: 'Jumping Jacks', clip: 'JumpingJacks' },
  confused: { label: 'Confused', clip: 'Confused' },
  sit: { label: 'Sit', clip: 'SittingEnter' },
})

export const EMOTE_CLIPS = new Map(Object.entries(EMOTES).map(([code, emote]) => [code, emote.clip]))

export const EMOTE_WHEEL_SLOTS = Object.freeze(
  Object.entries(EMOTES).map(([code, emote]) => Object.freeze({ code, label: emote.label }))
)

const isFiniteVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)

export function predictHit(origin, dir, players, selfId, headshotZone) {
  const direction = normalizeShotDirection(dir)
  if (!isFiniteVec3(origin) || !direction || !Array.isArray(players)) return null
  for (const p of players) {
    if (!p || String(p.id) === String(selfId) || !isFiniteVec3(p.position)) continue
    if ((p.health ?? 100) <= 0) continue
    const hit = rayVsCapsule(origin, direction, PREDICT_RANGE_M, p.position, DEFAULT_HITBOX)
    if (!hit) continue
    return { headshot: hitHeightRatio(hit.proj, p.position, DEFAULT_HITBOX) >= (headshotZone ?? DEFAULT_HEADSHOT_ZONE) }
  }
  return null
}
