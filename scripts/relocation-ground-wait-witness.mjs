#!/usr/bin/env node
// RELOCATION GROUND WAIT -- a relocation to a point may not release the player before its ground does.
//
// Owner report 2026-10-13/14, the deterministic repro:
//   http://localhost:3001/?singleplayer&terrainhash=1&at=-2750,-750
//   1. spawns standing on a spot that does not touch the ground
//   2. the player keeps dying over and over
//   3. grass and terrain polys do not line up
//
// WHAT THIS WITNESS PINS (the death loop, measured before the change):
//   * `?terrainhash=1` makes src/shared/terrainConfig.js withTerrainHashVersion() rewrite
//     hashVersion while leaving bakedHeightfield = /apps/world/tps-game.hf, which was baked at
//     hashVersion 2. src/terrain/TerrainPhysics.js loadBakedHeightField() therefore rejects the
//     only cheap collider source ("baked with terrain hashVersion 2, world uses 1") and the
//     collider falls back to the exact CPU solve, which took 12792 ms to land its first 256 m
//     field at (-2750,-750) instead of the 1726 ms the bake needs.
//   * src/sdk/Relocation.js teleportPlayer() -- the `?at=` path -- armed the hold with
//     TeleportHold's own TELEPORT_HOLD_MAX_MS (8000 ms) and its bare 60 m downward raycast,
//     neither of which can tell "no collider field here yet" from "no ground here at all". It
//     released the player into the air at 8 s, the player fell through the absent ground, and
//     src/behaviours/combat.js killByFall (fallKillDepth 20 m, fallKillGraceSec 0.5 s) took it;
//     respawnTime 1.5 s put it back at a spawn point and the next relocation repeated it.
//   * Measured here before the change, world tps-game seed 1337, target (-2750,-750):
//       hashVersion 1: ground 54.90 m, ctx/physics terrainHeightAt NaN, player 56.15 -> 8.80 m
//                      in 4.5 s without ever becoming onGround, health 100 -> 0 at 3.5 s
//       hashVersion 2: ground -96.66 m, terrainHeightAt NaN, player -96.98 -> -147.07 m,
//                      health 100 -> 0 at 2.5 s
//     Both respawned at (-25, 8.39, -45), the declared spawn point.
//
// THE FIX, at its own layer and not by moving a player or a spawn height: a relocation waits for
// the same ground on the same budget as a spawn. teleportPlayer() now arms the hold with
// probeSpawnHoldGround (which knows terrainFieldMissingAt / coversPosition) and SPAWN_HOLD_MAX_MS,
// so "no collider field yet" holds the player instead of dropping it. One question, one probe,
// one budget -- the 8 s ceiling is no longer a second answer to the spawn path's 20 s.
//
// This witness never waits for a field to land, so it is fast and independent of how loaded the
// host is: it asserts the CONTRACT of the armed hold at an (x,z) no field covers yet.
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const href = (p) => pathToFileURL(resolve(ROOT, p)).href

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
const PORT = 39800 + Math.floor(Math.random() * 150)
process.env.WORLD = 'tps-game'
process.env.PORT = String(PORT)
process.env.EDITOR_TOKEN = 'witness-token'

const checks = []
const expect = (name, ok, detail) => {
  checks.push({ check: name, ok: ok === true, detail })
  console.log(`${ok === true ? '  [PASS] ' : '  [FAIL] '}${name}: ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { TELEPORT_HOLD_MAX_MS } = await import(href('src/netcode/TeleportHold.js'))
const { SPAWN_HOLD_REASON } = await import(href('src/sdk/Relocation.js'))
const teleportMod = await import(href('src/sdk/Relocation.js'))
const { boot } = await import(href('src/sdk/server.js'))
const server = await boot()
const ctx = server
const frame = ctx.physics?._planetFrame || null
if (!frame) { console.log('RESULT: FAIL: no planet frame on ctx.physics._planetFrame'); try { await server.stop() } catch {} process.exit(1) }

// placePlayerAt() ends in appRuntime.broadcastMessage, which a witness that boots only the world
// server may not carry; the relocation's own work is everything before that call.
if (!ctx.appRuntime) ctx.appRuntime = {}
if (typeof ctx.appRuntime.broadcastMessage !== 'function') ctx.appRuntime.broadcastMessage = () => {}

const TARGET = [-2750, -750]
const groundAt = (x, z) => { try { return frame.groundHeightLocal(x, z) } catch { return NaN } }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.binaryType = 'arraybuffer'
let playerId = null
const COALESCE_SENTINEL = 0xff
const { unpack } = await import(href('src/protocol/msgpack.js'))
function decodeFrame(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (!(bytes.length > 0 && bytes[0] === COALESCE_SENTINEL)) return [unpack(bytes)]
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 1
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true); off += 4
    if (off + len > bytes.length) break
    out.push(unpack(bytes.subarray(off, off + len)))
    off += len
  }
  return out
}
ws.on('message', (d) => {
  let msgs; try { msgs = decodeFrame(d) } catch { return }
  for (const m of msgs) if (m && m.type === 2 /* HANDSHAKE_ACK */ && playerId == null) playerId = m.payload?.playerId ?? null
})
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
for (let i = 0; i < 400 && playerId == null; i++) await sleep(50)
if (playerId == null) { console.log('RESULT: FAIL: no player joined'); try { await server.stop() } catch {} process.exit(1) }

// The streamer that owns the collider fields: AppRuntime._holdPlayerOverUnloadedGround asks
// ctx.physics._terrainStreamer, Relocation.terrainFieldMissingAt asks ctx._terrainStreamer, and
// only the ServerAPI/WorkerEntry boot sets the latter, so a witness has to accept either.
const streamer = ctx._terrainStreamer || ctx.physics?._terrainStreamer || null
expect('the world has a heightfield streamer whose coverage the relocation can ask about',
  !!streamer && typeof streamer.coversPosition === 'function',
  `streamer=${streamer ? 'present, coversPosition=' + typeof streamer.coversPosition : 'absent'}`)

const uncovered = !streamer || !streamer.coversPosition(TARGET[0], TARGET[1])
expect('the relocation target has no collider field covering it yet, so it is the uncovered case',
  uncovered === true, `coversPosition(${TARGET[0]}, ${TARGET[1]})=${uncovered ? 'false' : 'true'}`)

const groundY = groundAt(TARGET[0], TARGET[1])
const placedY = Number.isFinite(groundY) ? groundY + 2 : 60
teleportMod.teleportPlayer(ctx, playerId, { x: TARGET[0], y: placedY, z: TARGET[1] })

const player = ctx.playerManager.getPlayer(playerId)
const hold = player?.teleportHold || null
expect('the relocation armed a hold rather than dropping the player immediately', !!hold,
  `teleportHold=${hold ? 'armed' : 'MISSING (the player was released with no ground)'}`)

const budgetMs = hold ? hold.deadline - hold.startedAt : 0
expect('the relocation hold waits on the spawn ground budget, not the separate teleport ceiling',
  budgetMs >= 20000,
  `budget=${budgetMs} ms vs SPAWN_HOLD_MAX_MS=20000 and TELEPORT_HOLD_MAX_MS=${TELEPORT_HOLD_MAX_MS}`)
expect('the old teleport ceiling was strictly below the ground budget, so the budget check is not vacuous',
  TELEPORT_HOLD_MAX_MS < 20000, `TELEPORT_HOLD_MAX_MS=${TELEPORT_HOLD_MAX_MS} < 20000`)

const probed = hold && typeof hold.probeGroundY === 'function' ? hold.probeGroundY() : 'no-probe'
expect('while the field is missing the relocation hold probes no ground, instead of trusting a ray that misses',
  probed === null, `probeGroundY()=${JSON.stringify(probed)}`)
const outcome = teleportMod.probeSpawnHoldGround(ctx, [TARGET[0], placedY, TARGET[1]])
expect('while the field is missing the relocation finds no ground to release the player onto',
  outcome.y === null && outcome.reason !== null,
  `probeSpawnHoldGround -> y=${JSON.stringify(outcome.y)} reason=${JSON.stringify(outcome.reason)} (${uncovered ? 'the target is uncovered, so a null y is the waiting answer' : 'target covered'})`)

await sleep(1200)
const after = ctx.playerManager.getPlayer(playerId)
const st = after?.state
const fell = st ? placedY - st.position[1] : NaN
expect('one second later the uncovered player is still held and has not fallen',
  !!after?.teleportHold && Number.isFinite(fell) && Math.abs(fell) < 0.5,
  `held=${!!after?.teleportHold} fell=${Number.isFinite(fell) ? fell.toFixed(3) : 'n/a'} m from ${placedY.toFixed(2)} (onGround=${st?.onGround})`)
expect('the held player is still alive', st?.health === undefined || st.health === 100 || st.health > 0,
  `health=${st?.health}`)

console.log(`MEASURED relocation-ground-wait: target=(${TARGET[0]},${TARGET[1]}) groundY=${Number(groundY).toFixed(2)} placedY=${placedY.toFixed(2)} budget=${budgetMs} ms (teleport ceiling ${TELEPORT_HOLD_MAX_MS} ms) probe=${JSON.stringify(probed)} reason=${JSON.stringify(outcome.reason)}`)
const failed = checks.filter((c) => !c.ok).length
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} relocation-ground-wait -- ${checks.length} check(s), ${failed} failure(s), budget=${budgetMs}ms`)
try { ws.close() } catch {}
try { await server.stop() } catch {}
process.exit(failed ? 1 : 0)
