import { rayVsCapsule, hitHeightRatio, DEFAULT_HITBOX } from '../../src/netcode/Hitscan.js'

export const POWERUP_DEFS = [
  { type: 'damage', color: 0xff3344, emissive: 0xaa0000, buff: { duration: 20, speedMultiplier: 1, fireRateMultiplier: 1, damageMultiplier: 2 } },
  { type: 'speed', color: 0x33aaff, emissive: 0x0044aa, buff: { duration: 20, speedMultiplier: 1.5, fireRateMultiplier: 1, damageMultiplier: 1 } },
  { type: 'rapid', color: 0xffcc33, emissive: 0xaa6600, buff: { duration: 20, speedMultiplier: 1, fireRateMultiplier: 2, damageMultiplier: 1 } },
]
export const POWERUP_RESPAWN_MS = 15000
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
