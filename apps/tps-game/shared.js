// Constants and pure helpers shared between apps/tps-game/index.js's server and client app halves.

export const POWERUP_DEFS = [
  { type: 'damage', color: 0xff3344, emissive: 0xaa0000, buff: { duration: 20, speedMultiplier: 1, fireRateMultiplier: 1, damageMultiplier: 2 } },
  { type: 'speed', color: 0x33aaff, emissive: 0x0044aa, buff: { duration: 20, speedMultiplier: 1.5, fireRateMultiplier: 1, damageMultiplier: 1 } },
  { type: 'rapid', color: 0xffcc33, emissive: 0xaa6600, buff: { duration: 20, speedMultiplier: 1, fireRateMultiplier: 2, damageMultiplier: 1 } },
]
export const POWERUP_RESPAWN_MS = 15000
export const POWERUP_PICKUP_RADIUS = 1.7

// Emote wheel (roadmap #78): a short networked CODE (not a free-text clip name -- server allowlist
// in server.js), mapped to a real clip confirmed present in client/anim-lib.glb (109 real clips inspected
// live via gltf-transform, not guessed). Order here is the wheel's slot 1..8 (client/hud/EmoteWheel.js
// lays slots out clockwise from the top in this same array order).
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

export function spawnPowerup(ctx, id, def, position) {
  ctx.world.spawn(id, {
    position: [...position], scale: [0.55, 0.55, 0.55],
    custom: { mesh: 'box', powerup: def.type, color: def.color, emissive: def.emissive, emissiveIntensity: 0.7, light: def.color, lightIntensity: 0.9, lightRange: 6, spin: 1.6, hover: 0.35 }
  })
}

// mirrors server.js handleFire's hit geometry (capsule +0.9, radius 0.6) for client-side prediction; server stays authoritative
export function predictHit(origin, dir, players, selfId, headshotZone) {
  if (!origin || !dir || !players) return null
  for (const p of players) {
    if (!p || p.id === selfId || !p.position) continue
    if ((p.health ?? 100) <= 0) continue
    const tp = p.position
    const toX = tp[0] - origin[0], toY = tp[1] + 0.9 - origin[1], toZ = tp[2] - origin[2]
    const dot = toX * dir[0] + toY * dir[1] + toZ * dir[2]
    if (dot < 0 || dot > 1000) continue
    const px = origin[0] + dir[0] * dot, py = origin[1] + dir[1] * dot, pz = origin[2] + dir[2] * dot
    const ddx = px - tp[0], ddy = py - (tp[1] + 0.9), ddz = pz - tp[2]
    const d2 = ddx * ddx + ddy * ddy + ddz * ddz
    if (d2 > 0.36) continue
    return { headshot: ((py - tp[1]) / 1.8) >= (headshotZone ?? 0.7) }
  }
  return null
}
