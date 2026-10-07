import { rayVsCapsule, hitHeightRatio, DEFAULT_HITBOX } from '../../src/netcode/Hitscan.js'

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
  weather: { rainPerIntensity: 200, snowRainFraction: 0.25, wetPerStep: 8, dryPerStep: 1, maxMoisture: 200, hysteresis: 8 },
  firebreaks: { kinds: ['road', 'river'], water: true },
}
const PREDICT_RANGE_M = 1000
const DEFAULT_HEADSHOT_ZONE = 0.7

export const EMOTE_CLIPS = new Map([
  ['wave', 'Bow'],
  ['dance', 'DanceLoop'],
  ['nod', 'HeadNod'],
  ['victory', 'Victory'],
  ['meditate', 'Meditate'],
  ['jumpingjacks', 'JumpingJacks'],
  ['confused', 'Confused'],
  ['sit', 'SittingEnter'],
])
export const EMOTE_WHEEL_SLOTS = [
  { code: 'wave', label: 'Bow' },
  { code: 'dance', label: 'Dance' },
  { code: 'nod', label: 'Nod' },
  { code: 'victory', label: 'Victory' },
  { code: 'meditate', label: 'Meditate' },
  { code: 'jumpingjacks', label: 'Jumping Jacks' },
  { code: 'confused', label: 'Confused' },
  { code: 'sit', label: 'Sit' },
]

export function predictHit(origin, dir, players, selfId, headshotZone) {
  if (!origin || !dir || !players) return null
  for (const p of players) {
    if (!p || p.id === selfId || !p.position) continue
    if ((p.health ?? 100) <= 0) continue
    const hit = rayVsCapsule(origin, dir, PREDICT_RANGE_M, p.position, DEFAULT_HITBOX)
    if (!hit) continue
    return { headshot: hitHeightRatio(hit.proj, p.position, DEFAULT_HITBOX) >= (headshotZone ?? DEFAULT_HEADSHOT_ZONE) }
  }
  return null
}
