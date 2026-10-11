import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stampSender } from '../src/sdk/appEventSender.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODULE = path.join(REPO, 'src', 'behaviours', 'combat.js')
const WITNESS = 'scripts/combat-witness.mjs'
const DC = {
  respawnTime: 1.5, health: 100, damagePerHit: 20, headshotMultiplier: 2.5, headshotZone: 0.7,
  hitKnockback: 4, shootKnockback: 2, magazineSize: 30, reloadTime: 2000, spawnInvulnMs: 1500,
  fallKillDepth: 20, fallKillGraceSec: 0.5, buffRegenFractionPerSec: 0.1, range: 1000
}

let nowMs = 1700000000000
// The module reads Date.now directly, so every timer runs on this fake clock.
Date.now = () => nowMs
console.log = () => {}

const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
  const m = /^--(module|out|log)=(.*)$/.exec(arg)
  return m ? [m[1], m[2]] : [arg, true]
}))
const modulePath = path.resolve(REPO, typeof flags.module === 'string' ? flags.module : DEFAULT_MODULE)
const outPath = typeof flags.out === 'string' ? path.resolve(REPO, flags.out) : null
const logPath = typeof flags.log === 'string' ? path.resolve(REPO, flags.log) : null
const slash = p => p.split(path.sep).join('/')

const rows = []
let total = 0
let passed = 0
const show = v => (v === undefined ? 'undefined' : typeof v === 'function' ? 'function' : JSON.stringify(v))
function check(id, desc, ok, expected, got) {
  total++
  if (ok) passed++
  rows.push(ok ? `ok ${id} ${desc}` : `not ok ${id} ${desc} expected=${expected} got=${got}`)
}
const truthy = (id, desc, value) => check(id, desc, value === true, 'true', show(value))
const eq = (id, desc, actual, expected) => check(id, desc, isDeepStrictEqual(actual, expected), show(expected), show(actual))
function throwsAs(id, desc, fn, message) {
  let thrown = null
  try { fn() } catch (e) { thrown = e }
  check(id, desc, thrown instanceof TypeError && thrown.message === message, show(message), thrown ? show(thrown.message) : 'no throw')
}
async function scenario(name, fn) {
  try { await fn() } catch (e) { check(`${name}.threw`, 'scenario ran without an unexpected exception', false, 'no exception', show(String(e && e.message))) }
}

function harness(o = {}) {
  const h = {
    players: new Map(), sent: [], broadcasts: [], spawned: [], destroyed: [], raycasts: [],
    persistedKeys: [], setPositions: [], events: [], hitTarget: null, heightRatio: 0.5, board: null,
    time: { tick: 1 }
  }
  h.ctx = {
    terrainBodyId: 77,
    time: h.time,
    lagCompensator: { latestTick: 10 },
    players: {
      getById: id => h.players.get(id),
      getAll: () => [...h.players.values()],
      send: (pid, msg) => { h.sent.push({ pid, msg }) },
      setPosition: (pid, p) => {
        h.setPositions.push({ pid, p: [...p] })
        const player = h.players.get(pid)
        if (player && player.state) player.state.position = [...p]
      }
    },
    world: {
      spawn: (id, opts) => { h.spawned.push({ id, opts }) },
      destroy: id => { h.destroyed.push(id) },
      sendToEntity: () => {}
    },
    network: { broadcast: msg => { h.broadcasts.push(msg) } },
    raycast: (origin, dir, reach, body) => {
      h.raycasts.push({ origin, dir, reach, body })
      return o.raycast ? o.raycast() : { hit: false }
    },
    terrainHeightAt: (x, z) => (o.terrainHeightAt ? o.terrainHeightAt(x, z) : 0),
    fallFloorY: () => -10,
    persisted: (key, fallback) => {
      h.persistedKeys.push(key)
      const store = {
        value: o.seed ?? { ...fallback },
        ready: Promise.resolve(),
        saves: 0,
        flushes: 0,
        save() { store.saves++ },
        flush() { store.flushes++; return Promise.resolve() }
      }
      h.board = store
      return store
    },
    combat: {
      DEFAULT_HITBOX: { radiusSq: 0.25, centerHeight: 1 },
      normalizeShotDirection: d => (Array.isArray(d) && d.length === 3 && d.every(Number.isFinite) ? d : null),
      resolveFireRequest: (_lag, _id, pos) => ({ origin: [...pos], viewTick: 9 }),
      buildLiveIndex: list => ({ count: list.length }),
      findHitSpatial: (list, shot) => {
        const target = list.find(p => p.id === h.hitTarget)
        if (!target || (shot.isTargetable && !shot.isTargetable(target))) return null
        return { target, tp: [...target.state.position], rewound: false, proj: [0, 1, 5] }
      },
      hitHeightRatio: () => h.heightRatio,
      recordHit: () => {}
    },
    eventLog: { record: (type, data, meta) => { h.events.push({ type, data, meta }) } },
    pickSpawnPoint: points => [...points[0]]
  }
  return h
}

function addPlayer(h, id, name, o = {}) {
  const player = {
    id,
    name,
    socket: o.peer ? { _peerId: o.peer } : undefined,
    state: { health: 100, position: [...(o.position || [0, 0, 0])], velocity: [0, 0, 0], onGround: o.onGround !== false }
  }
  h.players.set(id, player)
  return player
}
const serverEvent = (playerId, msg) => stampSender(msg, { id: playerId, fromClient: false })
const clientEvent = (playerId, msg) => stampSender(msg, { id: playerId, fromClient: true })
const join = (rt, ...ids) => ids.forEach(playerId => rt.handle(serverEvent(playerId, { type: 'player_join', playerId })))
const fire = (rt, senderId, direction = [0, 0, 1]) => rt.handle(clientEvent(senderId, { type: 'fire', senderId, direction }))
const hits = h => h.broadcasts.filter(m => m.type === 'hit')

async function suite(mod) {
  const { defineCombat, DEFAULT_COMBAT } = mod
  truthy('M1', 'module exports defineCombat as a function', typeof defineCombat === 'function')
  truthy('M2', 'default export is defineCombat', typeof defineCombat === 'function' && mod.default === defineCombat)
  truthy('M3', 'DEFAULT_COMBAT is a frozen object', typeof DEFAULT_COMBAT === 'object' && DEFAULT_COMBAT !== null && Object.isFrozen(DEFAULT_COMBAT))
  eq('M4', 'DEFAULT_COMBAT carries the shipped tuning', DEFAULT_COMBAT, DC)

  await scenario('S1', () => {
    const ctx0 = harness().ctx
    throwsAs('S1.ctx', 'defineCombat refuses a missing appCtx', () => defineCombat({}), '[combat] appCtx is required')
    throwsAs('S1.spec-null', 'null spec is refused', () => defineCombat(null, ctx0), '[combat] spec must be an object')
    throwsAs('S1.spec-array', 'array spec is refused', () => defineCombat([], ctx0), '[combat] spec must be an object')
    throwsAs('S1.config-type', 'non-object config is refused', () => defineCombat({ config: 'x' }, ctx0), '[combat] spec.config must be an object')
    throwsAs('S1.powerups-type', 'non-array powerups are refused', () => defineCombat({ powerups: {} }, ctx0), '[combat] spec.powerups must be an array')
    throwsAs('S1.health-zero', 'zero health is refused', () => defineCombat({ config: { health: 0 } }, ctx0), '[combat] spec.config.health must be a finite number greater than 0, got 0')
    throwsAs('S1.magazine-fraction', 'fractional magazine is refused', () => defineCombat({ config: { magazineSize: 1.5 } }, ctx0), '[combat] spec.config.magazineSize must be an integer of at least 1, got 1.5')
    throwsAs('S1.headshot-zone', 'headshot zone above 1 is refused', () => defineCombat({ config: { headshotZone: 1.5 } }, ctx0), '[combat] spec.config.headshotZone must be a finite number between 0 and 1, got 1.5')
    throwsAs('S1.powerup-respawn', 'negative powerup respawn is refused', () => defineCombat({ powerupRespawnMs: -1 }, ctx0), '[combat] spec.powerupRespawnMs must be a finite number of at least 0, got -1')
    throwsAs('S1.scoreboard-empty', 'empty scoreboard key is refused', () => defineCombat({ scoreboardKey: '' }, ctx0), '[combat] spec.scoreboardKey must be a non-empty string, got ""')
    throwsAs('S1.hook-type', 'non-function hook is refused', () => defineCombat({ onKill: 5 }, ctx0), '[combat] spec.onKill must be a function')
    throwsAs('S1.spawn-type', 'non-array spawnPoints are refused', () => defineCombat({ spawnPoints: 'x' }, ctx0), '[combat] spec.spawnPoints must be an array, got "x"')
    throwsAs('S1.spawn-arity', 'two-component spawn point is refused', () => defineCombat({ spawnPoints: [[1, 2]] }, ctx0), '[combat] spec.spawnPoints[0] must be an array of 3 finite numbers, got [1,2]')
    throwsAs('S1.powerup-entry', 'null powerup entry is refused', () => defineCombat({ powerups: [null] }, ctx0), '[combat] spec.powerups[0] must be an object')
    throwsAs('S1.powerup-type', 'empty powerup type is refused', () => defineCombat({ powerups: [{ type: '', buff: { duration: 1 } }] }, ctx0), '[combat] spec.powerups[0].type must be a non-empty string')
    throwsAs('S1.powerup-buff', 'powerup without buff is refused', () => defineCombat({ powerups: [{ type: 'speed' }] }, ctx0), '[combat] spec.powerups[0].buff must be an object')
    throwsAs('S1.powerup-duration', 'string buff duration is refused', () => defineCombat({ powerups: [{ type: 'speed', buff: { duration: '5' } }] }, ctx0), '[combat] spec.powerups[0].buff.duration must be a finite number')

    const merged = defineCombat({ config: { health: 150 }, spawnPoints: [[0, 1, 0]] }, harness().ctx)
    eq('S1.config-merge', 'a partial config overrides one field and keeps the defaults', merged.config, { ...DC, health: 150 })
    eq('S1.defaults-untouched', 'defineCombat does not mutate DEFAULT_COMBAT', DEFAULT_COMBAT.health, 100)
    const api = ['statsOf', 'ammoOf', 'isRespawning', 'buffOf', 'onChartReanchor', 'setup', 'tick', 'handle', 'flush']
    truthy('S1.api', 'returned object exposes the combat API', api.every(k => typeof merged[k] === 'function'))
    const hk = harness()
    defineCombat({ scoreboardKey: 'arena', spawnPoints: [[0, 0, 0]] }, hk.ctx)
    eq('S1.scoreboard-key', 'a custom scoreboardKey names the persisted record', hk.persistedKeys, ['arena'])
  })

  await scenario('S2', () => {
    const input = [[1, 2, 3], [4, 5, 6]]
    const hA = harness()
    const rA = defineCombat({ spawnPoints: input }, hA.ctx)
    input[0][0] = 99
    eq('S2.explicit-copy', 'explicit spawn points are copied, not aliased', rA.spawnPoints, [[1, 2, 3], [4, 5, 6]])
    eq('S2.explicit-no-scan', 'explicit spawn points skip the raycast scan', hA.raycasts.length, 0)

    const hB = harness({ raycast: () => ({ hit: true, position: [0, 2, 0] }), terrainHeightAt: () => 0 })
    const rB = defineCombat({}, hB.ctx)
    eq('S2.scan-count', 'the scan covers a 9 x 9 grid of 200 m cells over +-800 m', rB.spawnPoints.length, 81)
    eq('S2.scan-first', 'first scanned point sits the spawn margin above the ground', rB.spawnPoints[0], [-800, 5, -800])
    eq('S2.scan-last', 'last scanned point sits the spawn margin above the ground', rB.spawnPoints[80], [800, 5, 800])
    eq('S2.scan-ray', 'first ray drops from 20 m with a 30 m reach against the terrain body', hB.raycasts[0], { origin: [-800, 20, -800], dir: [0, -1, 0], reach: 30, body: 77 })
    eq('S2.scan-rays', 'one ray per grid cell', hB.raycasts.length, 81)

    const hC = harness({ raycast: () => ({ hit: false }), terrainHeightAt: () => NaN })
    const rC = defineCombat({}, hC.ctx)
    eq('S2.fallback', 'no ground falls back to four fixed points 8 m up', rC.spawnPoints, [[0, 8, 0], [100, 8, 200], [-100, 8, -100], [200, 8, 500]])
  })

  await scenario('S3', async () => {
    const h = harness()
    addPlayer(h, 'a', 'Alice', { position: [10.5, 4.6, 10] })
    addPlayer(h, 'b', 'Bob', { position: [0, 0, 5] })
    const picked = []
    const rt = defineCombat({
      spawnPoints: [[0, 0, 0], [10, 4, 10], [20, 0, 20]],
      powerups: [{ type: 'rage', color: 0xff0000, emissive: 0x330000, buff: { duration: 5, speedMultiplier: 2, damageMultiplier: 2 } }],
      powerupRespawnMs: 1000,
      onPowerup: (_ctx, info) => { picked.push(info.playerId) }
    }, h.ctx)
    await rt.setup()
    eq('S3.powerup-spawn-count', 'setup places one powerup entity', h.spawned.length, 1)
    eq('S3.powerup-spawn-id', 'powerup entity id is powerup_<type>', h.spawned[0].id, 'powerup_rage')
    eq('S3.powerup-spawn-pos', 'powerup hovers 0.6 m above the middle spawn point', h.spawned[0].opts.position, [10, 4 + 0.6, 10])
    eq('S3.powerup-spawn-custom', 'powerup colour payload', h.spawned[0].opts.custom, { mesh: 'box', color: 0xff0000, emissive: 0x330000, emissiveIntensity: 0.7, light: 0xff0000, lightIntensity: 0.9, lightRange: 6, spin: 1.6, hover: 0.35, powerup: 'rage' })
    join(rt, 'a', 'b')
    eq('S3.join-ammo', 'joining grants a full magazine', rt.ammoOf('a'), 30)
    const t0 = nowMs
    rt.tick(0.1)
    eq('S3.pickup-despawn', 'pickup destroys the powerup entity', h.destroyed, ['powerup_rage'])
    eq('S3.pickup-event', 'pickup sends the buff to the picker', h.sent.filter(s => s.msg.type === 'buff_applied'), [{ pid: 'a', msg: { type: 'buff_applied', duration: 5, speed: 2, fireRate: 1, damage: 2 } }])
    eq('S3.pickup-callback', 'onPowerup fires once for the picker', picked, ['a'])
    eq('S3.buff-state', 'buff expires duration seconds after pickup', rt.buffOf('a'), { expiresAt: t0 + 5000, speed: 2, fireRate: 1, damage: 2 })
    h.hitTarget = 'b'
    h.heightRatio = 0.5
    fire(rt, 'a')
    eq('S3.buffed-damage', 'damage multiplier doubles a body hit to 40', hits(h).map(m => [m.damage, m.health, m.headshot]), [[40, 60, false]])
    eq('S3.buffed-hit-msg', 'hit broadcast carries the full payload', hits(h), [{ type: 'hit', shooter: 'a', target: 'b', damage: 40, health: 60, headshot: false, pos: [0, 1, 5], dir: [0, 0, 1], knockback: 4 }])
    eq('S3.victim-health', 'victim loses the buffed damage', h.players.get('b').state.health, 60)
    eq('S3.shot-ammo', 'a shot consumes one round', rt.ammoOf('a'), 29)
    eq('S3.scoreboard', 'shooter damage is persisted under the player key', h.board.value['player:a'].damage, 40)
    h.players.get('a').state.position = [50, 0, 50]
    nowMs = t0 + 1000
    rt.tick(0.1)
    eq('S3.powerup-respawn', 'powerup respawns after powerupRespawnMs', h.spawned.map(s => s.id), ['powerup_rage', 'powerup_rage'])
    eq('S3.buff-live', 'buff is still active before expiry', rt.buffOf('a') !== null, true)
    nowMs = t0 + 5000
    rt.tick(0.1)
    eq('S3.buff-expired', 'buff clears at expiry', rt.buffOf('a'), null)
    eq('S3.buff-expired-msg', 'expiry is announced to the player', h.sent.some(s => s.pid === 'a' && s.msg.type === 'buff_expired'), true)
  })

  await scenario('S4', () => {
    const tKill = nowMs
    const h = harness()
    addPlayer(h, 'a', 'Alice')
    addPlayer(h, 'b', 'Bob', { position: [0, 0, 5] })
    const rt = defineCombat({ spawnPoints: [[-50, 2, -50], [50, 2, 50]] }, h.ctx)
    join(rt, 'a', 'b')
    h.hitTarget = 'b'
    h.heightRatio = 0.8
    fire(rt, 'a')
    eq('S4.headshot', 'headshot zone multiplies damage by 2.5 to 50', hits(h).map(m => [m.damage, m.health, m.headshot]), [[50, 50, true]])
    h.heightRatio = 0.5
    fire(rt, 'a')
    fire(rt, 'a')
    fire(rt, 'a')
    eq('S4.victim-dead', 'the fourth shot is lethal and health floors at zero', h.players.get('b').state.health, 0)
    eq('S4.kill-flag', 'victim is respawning after the kill', rt.isRespawning('b'), true)
    eq('S4.death-msg', 'death broadcast names the killer and streak', h.broadcasts.filter(m => m.type === 'death'), [{ type: 'death', victim: 'b', killer: 'a', killerName: 'Alice', headshot: false, streak: 1, killerKills: 1 }])
    eq('S4.killer-stats', 'killer gets one kill and every point of damage dealt', rt.statsOf('a'), { kills: 1, deaths: 0, damage: 110 })
    eq('S4.victim-stats', 'victim gets one death', rt.statsOf('b'), { kills: 0, deaths: 1, damage: 0 })
    const hitCount = hits(h).length
    fire(rt, 'a')
    eq('S4.dead-target-immune', 'a respawning player takes no further hits', hits(h).length, hitCount)
    const ammoB = rt.ammoOf('b')
    fire(rt, 'b')
    eq('S4.dead-shooter', 'a respawning player cannot fire', rt.ammoOf('b'), ammoB)
    nowMs = tKill + 1500
    rt.tick(0.016)
    eq('S4.respawn-flag', 'respawn clears the respawning flag', rt.isRespawning('b'), false)
    eq('S4.respawn-health', 'respawn restores full health', h.players.get('b').state.health, 100)
    eq('S4.respawn-position', 'respawn moves the player to the picked spawn point', h.setPositions.filter(s => s.pid === 'b').map(s => s.p), [[-50, 2, -50]])
    eq('S4.respawn-msg', 'respawn message carries position, health, ammo and invulnerability', h.sent.filter(s => s.pid === 'b' && s.msg.type === 'respawn').map(s => s.msg), [{ type: 'respawn', position: [-50, 2, -50], health: 100, ammo: 30, invulnMs: 1500 }])
    eq('S4.respawn-ammo', 'respawn refills the magazine', rt.ammoOf('b'), 30)
    const hitsAfterRespawn = hits(h).length
    fire(rt, 'a')
    eq('S4.invuln-blocks', 'shots at an invulnerable player do nothing', [h.players.get('b').state.health, hits(h).length], [100, hitsAfterRespawn])
    nowMs = tKill + 3000
    fire(rt, 'a')
    eq('S4.invuln-expires', 'invulnerability ends after spawnInvulnMs', h.players.get('b').state.health, 80)
  })

  await scenario('S5', () => {
    const h = harness()
    addPlayer(h, 'c', 'Cara', { position: [0, -30, 0], onGround: false })
    const rt = defineCombat({ spawnPoints: [[0, 0, 0]] }, h.ctx)
    rt.tick(0.25)
    eq('S5.grace', 'a fall shorter than the grace period is not lethal', [h.players.get('c').state.health, rt.isRespawning('c')], [100, false])
    rt.tick(0.25)
    eq('S5.fall-kill', 'falling past the grace period is lethal', [h.players.get('c').state.health, rt.isRespawning('c')], [0, true])
    eq('S5.fall-msg', 'fall death broadcast has no killer', h.broadcasts.filter(m => m.type === 'death'), [{ type: 'death', victim: 'c', killer: null, cause: 'fall' }])
    eq('S5.fall-stats', 'fall death counts as a death', rt.statsOf('c').deaths, 1)
  })

  await scenario('S6', () => {
    const h = harness()
    addPlayer(h, 'a', 'Alice')
    const rt = defineCombat({ spawnPoints: [[0, 0, 0]] }, h.ctx)
    join(rt, 'a')
    const t0 = nowMs
    rt.handle(clientEvent('a', { type: 'reload', senderId: 'a' }))
    eq('S6.full-reload-noop', 'reload with a full magazine starts nothing', h.sent.some(s => s.msg.type === 'reload_start'), false)
    fire(rt, 'a')
    fire(rt, 'a')
    fire(rt, 'a')
    eq('S6.ammo-after-three', 'three shots leave 27 rounds', rt.ammoOf('a'), 27)
    rt.handle(clientEvent('a', { type: 'reload', senderId: 'a' }))
    eq('S6.reload-start', 'a partial magazine starts a reload of reloadTime', h.sent.filter(s => s.msg.type === 'reload_start').map(s => s.msg), [{ type: 'reload_start', duration: 2000 }])
    fire(rt, 'a')
    eq('S6.fire-while-reloading', 'no shot is fired while reloading', rt.ammoOf('a'), 27)
    nowMs = t0 + 1999
    rt.tick(0.016)
    eq('S6.reload-pending', 'reload does not complete before reloadTime', rt.ammoOf('a'), 27)
    nowMs = t0 + 2000
    rt.tick(0.016)
    eq('S6.reload-complete', 'reload refills the magazine at reloadTime', [rt.ammoOf('a'), h.sent.filter(s => s.msg.type === 'reload_complete').map(s => s.msg)], [30, [{ type: 'reload_complete', ammo: 30 }]])
    for (let i = 0; i < 30; i++) fire(rt, 'a')
    eq('S6.magazine-empty', 'thirty more shots empty the magazine', rt.ammoOf('a'), 0)
    fire(rt, 'a')
    eq('S6.empty-click', 'an empty magazine clicks and stays at zero', [rt.ammoOf('a'), h.sent.some(s => s.msg.type === 'empty_click')], [0, true])
  })

  await scenario('S7', async () => {
    const h = harness()
    const rt = defineCombat({ spawnPoints: [[0, 0, 0], [10, 0, 0]], powerups: [{ type: 'rage', buff: { duration: 5 } }] }, h.ctx)
    await rt.setup()
    const moved = []
    rt.onChartReanchor({ transfer: { point: (from, to) => { moved.push([from, to]) } } })
    eq('S7.reanchor', 'chart re-anchor transfers every spawn point and powerup position', moved, [[[0, 0, 0], [0, 0, 0]], [[10, 0, 0], [10, 0, 0]], [[10, 0.6, 0], [10, 0.6, 0]]])
  })

  await scenario('S8', () => {
    const h = harness({ seed: { 'peer:peer-a': { name: 'Alice', kills: 3, deaths: 1, damage: 40, updatedAtMs: 1 } } })
    addPlayer(h, 'a', 'Alice', { peer: 'peer-a' })
    const rt = defineCombat({ spawnPoints: [[0, 0, 0]] }, h.ctx)
    eq('S8.persist-key', 'default scoreboard key is scoreboard', h.persistedKeys, ['scoreboard'])
    join(rt, 'a')
    eq('S8.restore', 'join restores saved stats keyed by peer id', rt.statsOf('a'), { kills: 3, deaths: 1, damage: 40 })
    h.board.value['peer:peer-a'].kills = 99
    rt.handle(serverEvent('a', { type: 'player_join', playerId: 'a', reconnected: true }))
    eq('S8.reconnect-keeps-live', 'a reconnect keeps the live stats', rt.statsOf('a').kills, 3)
    rt.handle(serverEvent('a', { type: 'player_leave', playerId: 'a' }))
    eq('S8.leave-persists', 'leave writes the live stats back over the record', h.board.value['peer:peer-a'].kills, 3)
    eq('S8.leave-clears', 'leave clears the live stats', rt.statsOf('a'), { kills: 0, deaths: 0, damage: 0 })
    eq('S8.unknown-type', 'unknown message types are not handled', rt.handle({ type: 'chat' }), false)
    eq('S8.null-msg', 'a null message is not handled', rt.handle(null), false)

    const seed = {}
    for (let i = 0; i < 200; i++) seed[`player:p${i}`] = { name: `P${i}`, kills: 0, deaths: 0, damage: 0, updatedAtMs: i + 1 }
    const ht = harness({ seed })
    addPlayer(ht, 'a', 'Alice')
    addPlayer(ht, 'b', 'Bob', { position: [0, 0, 5] })
    const rtT = defineCombat({ spawnPoints: [[0, 0, 0]] }, ht.ctx)
    join(rtT, 'a', 'b')
    ht.hitTarget = 'b'
    fire(rtT, 'a')
    eq('S8.trim-size', 'scoreboard is capped at 200 records', Object.keys(ht.board.value).length, 200)
    eq('S8.trim-evicts-oldest', 'the least recently updated record is evicted', ['player:p0' in ht.board.value, 'player:a' in ht.board.value], [false, true])
  })

  await scenario('S9', () => {
    const h = harness()
    addPlayer(h, 'a', 'Alice')
    addPlayer(h, 'b', 'Bob', { position: [0, 0, 5] })
    const blocked = []
    const rt = defineCombat({
      spawnPoints: [[0, 0, 0]],
      shotBlocked: (ctx, origin, direction) => { blocked.push({ sameCtx: ctx === h.ctx, origin, direction }); return true }
    }, h.ctx)
    join(rt, 'a')
    h.hitTarget = 'b'
    fire(rt, 'a', [0, 0, 1])
    eq('S9.blocked-no-damage', 'a shot refused by shotBlocked deals no damage', h.players.get('b').state.health, 100)
    eq('S9.blocked-hook', 'shotBlocked receives the context, origin and direction', blocked, [{ sameCtx: true, origin: [0, 0, 0], direction: [0, 0, 1] }])
    const hw = harness({ raycast: () => ({ hit: true, position: [1, 2, 3], normal: [0, 1, 0] }) })
    addPlayer(hw, 'a', 'Alice')
    const worldHits = []
    const rw = defineCombat({ spawnPoints: [[0, 0, 0]], onWorldHit: (_ctx, info) => { worldHits.push(info) } }, hw.ctx)
    join(rw, 'a')
    fire(rw, 'a', [0, 0, 1])
    eq('S9.world-hit-broadcast', 'a miss into the world broadcasts the impact', hw.broadcasts, [{ type: 'world_hit', shooter: 'a', pos: [1, 2, 3], normal: [0, 1, 0] }])
    eq('S9.world-hit-hook', 'onWorldHit receives the impact point', worldHits, [{ shooterId: 'a', position: [1, 2, 3] }])
  })
}

function resultLine(pass, reason) {
  return pass ? `RESULT: PASS claims=${passed}/${total}` : `RESULT: FAIL claims=${passed}/${total}${reason ? ` reason=${reason}` : ''}`
}
function render(pass, reason) {
  return [`combat-witness module=${slash(modulePath)}`, ...rows, resultLine(pass, reason)].join('\n') + '\n'
}

async function main() {
  if (!fs.existsSync(modulePath)) return 'module-missing'
  if (outPath && fs.existsSync(outPath)) return 'out-exists'
  let mod
  try {
    mod = await import(pathToFileURL(modulePath).href)
  } catch (e) {
    return 'module-load-failed'
  }
  await suite(mod)
  return ''
}

const early = await main()
let pass = !early && total > 0 && passed === total
let reason = early
let text = render(pass, reason)
let outRel = '-'
let sha = '-'
if (outPath && !early) {
  try {
    fs.writeFileSync(outPath, text, { flag: 'wx' })
    outRel = path.relative(REPO, outPath).split(path.sep).join('/')
    sha = crypto.createHash('sha256').update(text).digest('hex')
  } catch (e) {
    pass = false
    reason = 'out-write-failed'
    text = render(false, reason)
  }
}
if (logPath) {
  const variant = modulePath === DEFAULT_MODULE ? 'default' : 'override'
  const line = `${new Date().toISOString()} witness=${WITNESS} exit=${pass ? 0 : 1} ${resultLine(pass, reason)} variant=${variant} module=${slash(modulePath)} sha256=${sha} out=${outRel}`
  try {
    fs.appendFileSync(logPath, line + '\n')
  } catch (e) {
    pass = false
    reason = 'log-write-failed'
    text = render(false, reason)
  }
}
process.stdout.write(text)
process.exitCode = pass ? 0 : 1
