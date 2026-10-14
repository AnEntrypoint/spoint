#!/usr/bin/env node
// TPS-GAME DECLARED SPAWN HEIGHT, AND THE HOLD THAT GIVES UP WHERE GROUND IS ABSENT.
//
// Two defects on one surface -- "where does a spawn put the player" -- and both are measured, not
// asserted from the source.
//
// DEFECT 1 (src/sdk/Relocation.js + src/sdk/ServerHandlers.js, authored in
// apps/world/tps-game.js:50): the world declares spawnPoint [-25, 8.39, -45] and the four
// spawn-sillos-* entities share y=8.39 whatever the terrain does. The ground the collider probes at
// that (x,z) is ~-0.02 m, so the declared y authors an ~8.1 m gap: the player is created in the air
// and falls on every spawn and every respawn. The fix is NOT a corrected literal -- a number that is
// right for today's terrain drifts the moment the terrain moves -- but resolving the declared point
// through the probe that already decides where a held spawn is released
// (Relocation.probeSpawnGroundY -> physicsIntegration.standingCentreY).
//
// Measured, not re-typed: this witness boots the real world (src/sdk/server.js boot(), the same
// server a singleplayer page runs), records the position the spawn actually hands to
// playerManager.addPlayer, and compares it to the ground the collider reports at that same (x,z).
//
// DEFECT 2 (src/apps/AppRuntime.js _holdPlayerOverUnloadedGround): the hold bails out when
// physics.terrainHeightAt is non-finite, which is the one input that means "no ground here yet" --
// the case the hold exists for. A hold that releases on the signal to keep holding is how a player
// gets let go into the air. The fix makes a non-finite probe arm the hold on the same
// UNCOVERED_GROUND_HOLD_MAX_MS budget, so it still releases eventually instead of hanging.
//
// Both directions are pinned: restoring the authored height (i.e. not resolving) fails DEFECT 1's
// check, and reinstating the bail-out fails DEFECT 2's.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const WORLD = arg('world', 'tps-game')
// The row names both arms: the collider this world ships with, and ?terrainhash=1, which forces the
// exact CPU solve. SPOINT_TERRAIN_HASH is the node-side form of the same override, and the spawn has
// to land on the ground in BOTH, because the two disagree by metres here (measured below) and a
// spawn resolved against one of them is airborne on the other.
const TERRAIN_HASH = arg('terrain-hash', '')
if (TERRAIN_HASH) process.env.SPOINT_TERRAIN_HASH = TERRAIN_HASH
// The row's budget: a spawn whose y is not within this of the ground the collider probes is an
// authored airborne spawn. Compared against the standing centre, because the capsule CENTRE carries
// the standing offset by construction -- comparing the centre to the ground would report that offset
// as a metre of hover (measured standing offset here: 1.01 m).
const ACCEPT_SPAWN_M = Number(arg('accept-spawn-m', 0.15))
// SPAWN_HOLD_MAX_MS is the ceiling every spawn hold is on; a hold that can outlive it hangs.
const HOLD_BUDGET_MS = Number(arg('hold-budget-ms', 20000))
const SETTLE_MAX_MS = Number(arg('settle-max-ms', 20000))
const RAY_UP_M = 4000
const PORT = 39000 + Math.floor(Math.random() * 500)

process.env.WORLD = WORLD
process.env.PORT = String(PORT)
process.env.EDITOR_TOKEN = process.env.EDITOR_TOKEN || 'witness-token'

const checks = []
const expect = (name, ok, detail) => {
  checks.push({ check: name, ok: ok === true, detail })
  console.log(`${ok === true ? '  [PASS] ' : '  [FAIL] '}${name}: ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const n4 = (n) => (Number.isFinite(n) ? n.toFixed(4) : String(n))

// ================================================================ DEFECT 2: the groundless hold
// A unit arm on the real method: no server, no terrain. A stub physics whose terrain probe is
// non-finite is exactly the shape AppRuntime sees before a field lands.
{
  const { AppRuntime } = await import(href('src/apps/AppRuntime.js'))
  const { stepTeleportHold } = await import(href('src/netcode/TeleportHold.js'))
  const hold = AppRuntime.prototype._holdPlayerOverUnloadedGround
  const fakePlayer = () => ({ id: 'p1', state: { position: [0, 4, 0], velocity: [0, 0, 0], onGround: false }, teleportHold: null })

  // (a) ground absent: the terrain probe is non-finite AND no ray hits below.
  // The real cover test off the prototype: a bare object has no _terrainCoversPosition of its own,
  // and the hold's probe calls it, so the stub carries the real one and only the physics is faked.
  const COVERS = AppRuntime.prototype._terrainCoversPosition
  const rt = {
    _terrainCoversPosition: COVERS,
    _physics: {
      raycast: () => null,
      terrainHeightAt: () => NaN,
      _terrainStreamer: { coversPosition: () => true },
    },
  }
  const a = fakePlayer()
  hold.call(rt, a, [0, 4, 0])
  expect('groundless: a non-finite terrain probe ARMS the hold instead of releasing the player',
    !!a.teleportHold,
    `player.teleportHold=${a.teleportHold ? 'armed' : 'null (the hold bailed out)'} after terrainHeightAt=NaN and a downward ray that missed`)

  const armed = a.teleportHold
  const budget = armed ? armed.deadline - armed.startedAt : NaN
  expect(`groundless: the hold is on a finite budget that cannot outlive ${HOLD_BUDGET_MS} ms`,
    Number.isFinite(budget) && budget > 0 && budget <= HOLD_BUDGET_MS,
    `hold budget=${n4(budget)} ms (ceiling ${HOLD_BUDGET_MS} ms), so it still releases rather than hanging`)

  // (b) that hold must actually release at its deadline, with no ground ever appearing.
  let released = null
  if (armed) {
    armed.onRelease = (r) => { released = r }
    armed.deadline = Date.now() - 1
    const stillHolding = stepTeleportHold(a, { physicsWorld: { raycast: () => null } })
    expect('groundless: the hold RELEASES at its deadline with no ground, and does not hold forever',
      a.teleportHold === null && stillHolding === false && !!released && released.groundHit === false,
      `teleportHold=${a.teleportHold === null ? 'cleared' : 'still armed'} stepTeleportHold=${stillHolding} onRelease=${released ? `groundHit=${released.groundHit} heldMs=${Math.round(released.heldMs)}` : 'not called'}`)
  } else {
    expect('groundless: the hold RELEASES at its deadline with no ground, and does not hold forever', false, 'no hold was armed, so nothing could release')
  }

  // (c) control: ground present under the player -- nothing changes, no hold is armed.
  const rtHit = { _physics: { raycast: () => ({ hit: true, position: [0, 1, 0] }), terrainHeightAt: () => 1 } }
  const c = fakePlayer()
  hold.call(rtHit, c, [0, 1.01, 0])
  expect('control: ground already under the player still arms NO hold',
    !c.teleportHold,
    `player.teleportHold=${c.teleportHold ? 'armed' : 'null'} with a ray that hit at y=1`)

  // (d) control: a finite terrain probe far below the player is still out of the hold's reach.
  const rtFar = { _physics: { raycast: () => null, terrainHeightAt: () => -500 } }
  const d = fakePlayer()
  hold.call(rtFar, d, [0, 4, 0])
  expect('control: a player beyond the support ray of a KNOWN ground still arms NO hold',
    !d.teleportHold,
    `player.teleportHold=${d.teleportHold ? 'armed' : 'null'} at y=4 over a finite terrain of -500 m`)
}

// ================================================================ DEFECT 1: the declared spawn height
const { MSG } = await import(href('src/protocol/MessageTypes.js'))
const { pack, unpack } = await import(href('src/protocol/msgpack.js'))
const { encodeInputPacket, DEFAULT_INPUT_SCHEMA } = await import(href('src/protocol/InputCodec.js'))

const { boot } = await import(href('src/sdk/server.js'))
// A boot that throws (a bake the tree no longer hashes to, a missing world) is a FAILURE of this
// witness, not a crash with a stack: the gate reads the RESULT line.
let server = null
try {
  server = await boot()
} catch (e) {
  console.log(`RESULT: FAIL world=${WORLD} -- boot threw: ${(e && e.message) || e}`)
  process.exit(1)
}
const ctx = server
const physics = ctx.physics
console.log(`world=${WORLD} port=${PORT}`)

// The declared spawn, read out of the world module itself -- never re-typed here.
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', `${WORLD}.js`))
const declared = Array.isArray(loaded?.spawnPoint) ? [...loaded.spawnPoint] : null
expect('the world declares a spawn point', Array.isArray(declared) && declared.length === 3,
  `spawnPoint=${JSON.stringify(declared)}`)
if (!declared) {
  console.log(`RESULT: FAIL: no spawnPoint on apps/world/${WORLD}.js`)
  try { await server.stop() } catch {}
  process.exit(1)
}

const x = declared[0], z = declared[2]
const ray = physics.raycast([x, 400, z], [0, -1, 0], RAY_UP_M)
const physY = ray && ray.hit && Number.isFinite(ray.position?.[1]) ? ray.position[1] : NaN
const terrainY = typeof physics.terrainHeightAt === 'function' ? physics.terrainHeightAt(x, z) : NaN
const standY = ctx.physicsIntegration?.standingCentreY ? ctx.physicsIntegration.standingCentreY(physY) : NaN
console.log(`declared spawn=${declared.map((v) => n4(v)).join(',')} probed ground at (${n4(x)}, ${n4(z)}): collider ray=${n4(physY)} terrainHeightAt=${n4(terrainY)} standing centre=${n4(standY)}`)
expect('the collider probes a ground under the declared spawn', Number.isFinite(physY) && Number.isFinite(standY),
  `ray=${n4(physY)} standY=${n4(standY)}`)

// What the spawn actually hands to the player: recorded at the call that creates it, so the number
// comes out of the running game and not out of a second copy of the resolution.
const pm = ctx.playerManager
const origAddPlayer = pm.addPlayer.bind(pm)
let recordedSpawn = null
pm.addPlayer = (...args) => {
  if (recordedSpawn === null && args[1] && Array.isArray(args[1].position)) recordedSpawn = [...args[1].position]
  return origAddPlayer(...args)
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.binaryType = 'arraybuffer'
let playerId = null
let chartEpoch = 0
let sending = false
let inputSeq = 0
const COALESCE_SENTINEL = 0xff
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (!(bytes.length > 0 && bytes[0] === COALESCE_SENTINEL)) return [unpack(bytes)]
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true)
    off += 4
    if (off + len > bytes.length) break
    out.push(unpack(bytes.subarray(off, off + len)))
    off += len
  }
  return out
}
ws.on('message', (d) => {
  let msgs
  try { msgs = decodeFrame(d) } catch { return }
  for (const m of msgs) {
    if (m && m.type === MSG.HANDSHAKE_ACK && playerId == null) {
      playerId = m.payload.playerId
      chartEpoch = m.payload.chartEpoch || 0
      sending = true
    }
  }
})
await new Promise((r) => ws.on('open', r))
await sleep(1500)
const sendTimer = setInterval(() => {
  if (!sending) return
  inputSeq++
  try {
    ws.send(pack({ type: MSG.PLAYER_INPUT, payload: encodeInputPacket(DEFAULT_INPUT_SCHEMA, [{ sequence: inputSeq, data: { yaw: 0, pitch: 0, expr: 0 } }], chartEpoch) }))
  } catch {}
}, 1000 / 60)

const player = () => (playerId == null ? null : ctx.playerManager.getPlayer(playerId))
const t0 = Date.now()
while (Date.now() - t0 < SETTLE_MAX_MS) {
  const p = player()
  if (p && p.state.onGround && !p.teleportHold) break
  await sleep(120)
}
const p = player()
pm.addPlayer = origAddPlayer

if (!recordedSpawn) {
  expect('the spawn handed the player a position', false, 'playerManager.addPlayer was never called with a position, so the declared spawn was not measured')
} else {
  const gap = recordedSpawn[1] - standY
  console.log(`SPAWN declared=${declared.map((v) => n4(v)).join(',')} used=${recordedSpawn.map((v) => n4(v)).join(',')} ground=${n4(physY)} standY=${n4(standY)} gap=${n4(gap)} m`)
  expect(`the spawn the game uses is within ${ACCEPT_SPAWN_M} m of the ground the collider probes (declared ${n4(declared[1])} vs standing centre ${n4(standY)})`,
    Number.isFinite(gap) && Math.abs(gap) <= ACCEPT_SPAWN_M,
    `used y=${n4(recordedSpawn[1])} standing centre=${n4(standY)} gap=${n4(gap)} m, budget ${ACCEPT_SPAWN_M} m`)
  expect('the spawn keeps the declared (x,z): only the airborne y is resolved',
    recordedSpawn[0] === declared[0] && recordedSpawn[2] === declared[2],
    `used (${n4(recordedSpawn[0])}, ${n4(recordedSpawn[2])}) declared (${n4(declared[0])}, ${n4(declared[2])})`)
}

// The settled player: the spawn may resolve the y, but the player still has to come to rest on the
// collider, so this is the regression guard on the whole path.
const settledY = p ? p.state.position[1] : NaN
const settledGap = Number.isFinite(settledY) && Number.isFinite(standY) ? settledY - standY : NaN
expect(`the settled player rests on the ground the collider probes (within ${ACCEPT_SPAWN_M} m)`,
  p != null && Number.isFinite(settledGap) && Math.abs(settledGap) <= ACCEPT_SPAWN_M,
  `settled y=${n4(settledY)} standing centre=${n4(standY)} gap=${n4(settledGap)} m onGround=${p ? p.state.onGround : 'n/a'} held=${p ? !!p.teleportHold : 'n/a'}`)

clearInterval(sendTimer)
try { ws.close() } catch {}
try { await server.stop() } catch (e) { console.log(`server.stop: ${(e && e.message) || e}`) }
await sleep(200)

const failed = checks.filter((c) => !c.ok).length
for (const c of checks) if (!c.ok) console.log('FAIL: ' + c.check + ': ' + c.detail)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} world=${WORLD} -- ${checks.length} check(s), ${failed} failure(s), declared=${n4(declared[1])} used=${recordedSpawn ? n4(recordedSpawn[1]) : 'n/a'} standY=${n4(standY)}`)
process.exit(failed ? 1 : 0)
