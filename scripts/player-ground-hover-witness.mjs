#!/usr/bin/env node
// PLAYER HOVER ABOVE GRASS -- the four ground heights at one instant, at five distances.
//
// Owner report 2026-10-13, verbatim: "what it looks like is that we're hovering far above the
// grass". A player that stands higher than the grass is placed can read as grass that is too
// narrow, too small, or ringed by a gap, so this witness answers one question before anything is
// changed: WHICH ground is wrong.
//
// It boots the real world (src/sdk/server.js boot(), the same server a singleplayer page runs),
// puts a real character on it, and at each distance reports every ground a player can stand on and
// every ground grass can be placed on, all at the same (x,z):
//
//   playerY    src/sdk/Relocation.js -> playerManager state, after the real teleport hold releases
//              it (holdSpawnUntilGrounded), so this is where the game actually puts the player.
//   physY      src/terrain/TerrainPhysics.js colliderSource.heightFn -> the Jolt heightfield, read
//              by a downward ray. This is the surface the character controller stands on.
//   cpuY       src/terrain/PlanetFrame.js groundHeightLocal -- the exact CPU solve.
//   grassY     src/terrain/VegPlacement.js surfaceOfCell -> cell.at[1], the ground a grass blade
//              starts from, plus the nearest real blade's own y out of placementsForGrassChunk.
//   standY     physicsIntegration.standingCentreY(physY) -- where the player MUST rest if the
//              collider is the surface it stands on. playerY - standY is the hover, and it is the
//              only number here that separates "the player floats" from "the ground moved".
//
// The distance ladder is the point: a divergence that grows with distance is two different
// surfaces (a coarse far field under one of them); a divergence that is constant is an offset or a
// spawn that released without ground.
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
// A hover is only a hover if it is larger than the jitter of a settled character, and a standing
// character on a slope still bobs: the budget is the standing capsule's own slack, not a guess.
const ACCEPT_HOVER_M = Number(arg('accept-hover-m', 0.15))
const ACCEPT_PLAYER_GRASS_M = Number(arg('accept-player-grass-m', 0.40))
const DISTANCES_M = String(arg('distances', '0,50,100,200,400')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0)
const SETTLE_MAX_MS = Number(arg('settle-max-ms', 26000))
// A drop of this far above the standing centre, so the collider alone decides where it lands.
const DROP_M = Number(arg('drop-m', 1.5))
// Walk out in hops of at most this, so the heightfield streamer gets a centre to build around.
const HOP_M = Number(arg('hop-m', 40))
// A rung is only a rung if the player landed within this of it.
const RUNG_REACHED_M = Number(arg('rung-reached-m', 5))
const RAY_UP_M = 4000
const PORT = 38000 + Math.floor(Math.random() * 1500)

process.env.WORLD = WORLD
process.env.PORT = String(PORT)
process.env.EDITOR_TOKEN = process.env.EDITOR_TOKEN || 'witness-token'

const checks = []
const expect = (name, ok, detail) => {
  checks.push({ check: name, ok: ok === true, detail })
  console.log(`${ok === true ? '  [PASS] ' : '  [FAIL] '}${name}: ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { MSG } = await import(href('src/protocol/MessageTypes.js'))
const { pack, unpack } = await import(href('src/protocol/msgpack.js'))
const { encodeInputPacket, DEFAULT_INPUT_SCHEMA } = await import(href('src/protocol/InputCodec.js'))
// Bearing toward [640, 320], a chord the three-source witness already measured as open (uncarved)
// terrain that grows grass, so the far rungs of the ladder are not on the origin's flat carve.
const BEARING = Math.atan2(320, 640)

// ---------------------------------------------------------------- boot the real world
const { boot } = await import(href('src/sdk/server.js'))
const server = await boot()
const ctx = server
const physics = ctx.physics
const physicsWorld = ctx.physicsIntegration.physicsWorld
const frame = physics?._planetFrame || null
const streamer = physics?._terrainStreamer || null
if (!frame) { console.log('RESULT: FAIL: no planet frame on ctx.physics._planetFrame'); try { await server.stop() } catch {} process.exit(1) }

// The streamer owns the world's terrain config, but the placement seed is read straight out of the
// world module the way src/terrain placement does, so the grass arm cannot drift from it.
const { loadWorldModule } = await import(href('src/sdk/WorldLocator.js'))
const loaded = await loadWorldModule(resolve(ROOT, 'apps', 'world', `${WORLD}.js`))
const tcfg = loaded.terrain || ctx.currentWorldDef?.terrain || null
if (!tcfg) { console.log(`RESULT: FAIL: no terrain config for world=${WORLD} (currentWorldDef keys: ${Object.keys(ctx.currentWorldDef || {}).join(',')})`); try { await server.stop() } catch {} process.exit(1) }
console.log(`world=${WORLD} seed=${tcfg.seed} radius=${tcfg.radius} hashVersion=${tcfg.hashVersion ?? 2} baked=${tcfg.bakedHeightfield || '(none)'} groundSource=${frame.groundSource}`)
console.log(`collider=${streamer ? 'streaming' : 'none'} standingCentreY=${typeof ctx.physicsIntegration.standingCentreY}`)

const { placementsForGrassChunk, GRASS } = await import(href('src/terrain/GrassPlacement.js'))
const { createPlacementCell, placementCellAt, surfaceOfCell } = await import(href('src/terrain/VegPlacement.js'))
const { chunkKeyAtLocal, latticeFor } = await import(href('src/terrain/PlacementChart.js'))
const { createCachedAnchorField } = await import(href('src/terrain/ClimateCache.js'))
// placePlayerAt (src/sdk/Relocation.js) ends in appRuntime.broadcastMessage, which a bare server
// boot has no appRuntime for, so the whole teleport throws AFTER it has already moved the player and
// never arms the teleport hold. The placement the witness needs is the part before that call.
function placePlayer(playerId, position) {
  const cur = ctx.playerManager.getPlayer(playerId)
  if (!cur) return false
  const st = cur.state
  st.position[0] = position[0]; st.position[1] = position[1]; st.position[2] = position[2]
  st.velocity[0] = 0; st.velocity[1] = 0; st.velocity[2] = 0
  st.onGround = false
  st.swimming = false
  ctx.physicsIntegration.setPlayerPosition(playerId, position)
  const charId = ctx.physicsIntegration.playerBodies.get(playerId)?.charId
  if (charId) ctx.physicsIntegration.physicsWorld.setCharacterVelocity(charId, [0, 0, 0])
  ctx.playerManager.clearInputs(playerId)
  cur.lastInput = null
  return true
}

const anchorField = createCachedAnchorField(frame.sampler ? frame.sampler.anchorField : null, frame)
const lattice = latticeFor(frame, GRASS)
const CELL_JIT_X = 20, CELL_JIT_Z = 21

// ---------------------------------------------------------------- sources at one (x,z)
function physAt(x, z, fromY) {
  const start = (Number.isFinite(fromY) ? fromY : 0) + 50
  const h = physics.raycast([x, start, z], [0, -1, 0], RAY_UP_M)
  if (!h || !h.hit) return { y: NaN, bodyId: null }
  return { y: h.position[1], bodyId: h.bodyId ?? null }
}
function cpuAt(x, z) {
  try { return frame.groundHeightLocal(x, z) } catch { return NaN }
}
// The grass ground under (x,z): the placement cell whose own solve a blade starts from, and the
// nearest real blade out of the real placement walk. The cell is the surface; the blade carries the
// clump offset on top of it, so the two are reported separately and never averaged together.
// surfaceOfCell seeds each solve from the previous cell's rho, so the walk has to solve EVERY cell
// in placement order and keep the nearest: a walk that solves only the cell it is about to keep
// hands each solve an unseeded start and the number it produces is not a surface.
function grassAt(x, z) {
  let key
  try { key = chunkKeyAtLocal(lattice, frame, x, z) } catch { return { cellY: NaN, bladeY: NaN, bladeDistM: NaN } }
  const cell = createPlacementCell(frame)
  const cellSeed = (tcfg.seed | 0) ^ 0x6a55
  const dec = lattice.decodeChunk(key, [0, 0, 0])
  let best = null
  let solved = 0
  for (let gz = 0; gz < GRASS.GRID; gz++) {
    for (let gx = 0; gx < GRASS.GRID; gx++) {
      placementCellAt(frame, lattice, dec, gx, gz, cellSeed, GRASS.JITTER / GRASS.CELL, CELL_JIT_X, CELL_JIT_Z, cell)
      let rho = NaN
      try { rho = surfaceOfCell(frame, cell) } catch { rho = NaN }
      if (!Number.isFinite(rho)) continue
      solved++
      const d = Math.hypot(cell.at[0] - x, cell.at[2] - z)
      if (!Number.isFinite(d)) continue
      if (!best || d < best.d) best = { d, cellY: cell.at[1], rho }
    }
  }
  if (best) best.solved = solved
  let bladeY = NaN, bladeDistM = NaN
  let blades = null
  try { blades = placementsForGrassChunk(key, frame, anchorField, tcfg.seed | 0) } catch { blades = null }
  if (Array.isArray(blades)) {
    for (const b of blades) {
      const d = Math.hypot(b.x - x, b.z - z)
      if (!Number.isFinite(d)) continue
      if (!Number.isFinite(bladeDistM) || d < bladeDistM) { bladeDistM = d; bladeY = b.y }
    }
  }
  return { cellY: best ? best.cellY : NaN, cellRhoY: best ? best.rho : NaN, cellDistM: best ? best.d : NaN, bladeY, bladeDistM }
}

// ---------------------------------------------------------------- a real player
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
ws.binaryType = 'arraybuffer'
let playerId = null
let chartEpoch = 0
let sending = false
let inputSeq = 0
// The server coalesces a burst into one frame: 0xff then [uint32 LE length][msgpack] repeatedly.
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
await sleep(1800)
const sendTimer = setInterval(() => {
  if (!sending) return
  inputSeq++
  try {
    ws.send(pack({ type: MSG.PLAYER_INPUT, payload: encodeInputPacket(DEFAULT_INPUT_SCHEMA, [{ sequence: inputSeq, data: { yaw: 0, pitch: 0, expr: 0 } }], chartEpoch) }))
  } catch {}
}, 1000 / 60)

const player = () => (playerId == null ? null : ctx.playerManager.getPlayer(playerId))
let p = player()
if (!p) {
  console.log('RESULT: FAIL: no player after handshake')
  clearInterval(sendTimer); try { ws.close() } catch {} ; try { await server.stop() } catch {} ; process.exit(1)
}
console.log(`spawn=${p.state.position.map((n) => n.toFixed(3)).join(',')} onGround=${p.state.onGround}`)

// ---------------------------------------------------------------- the ladder
const settleAt = async (x, z) => {
  const t0 = Date.now()
  while (Date.now() - t0 < SETTLE_MAX_MS) {
    const cur = player()
    if (cur && cur.state.onGround && !cur.teleportHold) return { ok: true, waitedMs: Date.now() - t0 }
    if (streamer && typeof streamer.coversPosition === 'function' && !streamer.coversPosition(x, z)) { await sleep(200); continue }
    await sleep(120)
  }
  return { ok: false, waitedMs: Date.now() - t0 }
}

const waitCovered = async (x, z, budgetMs) => {
  if (!streamer || typeof streamer.coversPosition !== 'function') return true
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    if (streamer.coversPosition(x, z)) return true
    await sleep(150)
  }
  return false
}
// A player dropped where no collider field exists yet falls out of the world and is respawned at the
// spawn point, which would let a far rung measure the spawn twice and pass. The ladder therefore
// walks out in hops, giving the heightfield streamer a centre to build around at each one, and then
// VERIFIES the player really is at the rung before any number from it is counted.
const hopTo = async (x, z) => {
  const cur = player()
  if (!cur) return false
  const from = [cur.state.position[0], cur.state.position[2]]
  const legs = Math.max(1, Math.ceil(Math.hypot(x - from[0], z - from[1]) / HOP_M))
  for (let i = 1; i <= legs; i++) {
    const hx = from[0] + ((x - from[0]) * i) / legs
    const hz = from[1] + ((z - from[1]) * i) / legs
    const g = cpuAt(hx, hz)
    const gy = Number.isFinite(g) ? ctx.physicsIntegration.standingCentreY(g) : null
    placePlayer(playerId, [hx, gy === null ? 220 : gy, hz])
    await waitCovered(hx, hz, 8000)
    await sleep(200)
  }
  return true
}

const rows = []
for (const d of DISTANCES_M) {
  // A fixed bearing away from the arena carve: the ladder has to walk open terrain, because the
  // chord carve flattens the first 100 m around the origin and a flat carve hides a divergence.
  const x = d === 0 ? 0 : Math.round(Math.cos(BEARING) * d)
  const z = d === 0 ? 0 : Math.round(Math.sin(BEARING) * d)
  await hopTo(x, z)
  const cpu0 = cpuAt(x, z)
  const ray0 = physAt(x, z, cpu0)
  // Dropped from above the standing centre so the collider alone decides where it comes to rest:
  // placing it at the standing centre would make the answer a copy of the guess.
  const dropY = Number.isFinite(ray0.y) ? ctx.physicsIntegration.standingCentreY(ray0.y) + DROP_M : (Number.isFinite(cpu0) ? cpu0 + DROP_M + 1.5 : 220)
  const placed = placePlayer(playerId, [x, dropY, z])
  if (!placed) console.log(`d=${d} placement refused: no player ${playerId}`)
  const st = await settleAt(x, z)
  const cur = player()
  const px = cur ? cur.state.position[0] : NaN
  const py = cur ? cur.state.position[1] : NaN
  const pz = cur ? cur.state.position[2] : NaN
  const ph = physAt(px, pz, cpu0)
  const cpu = cpuAt(px, pz)
  const gr = grassAt(px, pz)
  const standY = Number.isFinite(ph.y) ? ctx.physicsIntegration.standingCentreY(ph.y) : NaN
  // The player's Y is the capsule CENTRE, so the number that reads as a hover is the feet against
  // the grass: the centre carries the capsule's own standing offset (measured 1.01 m here), and
  // comparing the centre to the ground would report that offset as a metre of hover.
  const offsetM = Number.isFinite(standY) && Number.isFinite(ph.y) ? standY - ph.y : NaN
  const feetY = Number.isFinite(py) && Number.isFinite(offsetM) ? py - offsetM : NaN
  const row = {
    d, x: +px.toFixed(3), z: +pz.toFixed(3),
    playerY: +py.toFixed(4), feetY: +feetY.toFixed(4), physY: +ph.y.toFixed(4), cpuY: +cpu.toFixed(4),
    grassCellY: +gr.cellY.toFixed(4), grassBladeY: +gr.bladeY.toFixed(4),
    standY: +standY.toFixed(4), standingOffsetM: +offsetM.toFixed(4),
    hoverM: +(py - standY).toFixed(4),
    feetMinusGrassM: +(feetY - gr.cellY).toFixed(4),
    feetMinusBladeM: +(feetY - gr.bladeY).toFixed(4),
    playerMinusGrassM: +(py - gr.cellY).toFixed(4),
    physMinusCpuM: +(ph.y - cpu).toFixed(4),
    grassMinusPhysM: +(gr.cellY - ph.y).toFixed(4),
    grassMinusCpuM: +(gr.cellY - cpu).toFixed(4),
    onGround: cur ? !!cur.state.onGround : null,
    held: cur ? !!cur.teleportHold : null,
    settleMs: st.waitedMs, settled: st.ok,
    // A rung the player never reached measures the last rung again, so the miss is recorded and the
    // rung is refused below rather than counted as a second sample of somewhere else.
    reachedM: +Math.hypot(px - x, pz - z).toFixed(3),
    reached: Math.hypot(px - x, pz - z) <= RUNG_REACHED_M,
    colliderCovers: streamer && typeof streamer.coversPosition === 'function' ? streamer.coversPosition(px, pz) : null,
  }
  rows.push(row)
  console.log(`DIST d=${d} at(${row.x},${row.z}) playerY=${row.playerY} feetY=${row.feetY} physY=${row.physY} cpuY=${row.cpuY} grassCellY=${row.grassCellY} bladeY=${row.grassBladeY} standY=${row.standY} offset=${row.standingOffsetM} | hover(player-stand)=${row.hoverM} feet-grass=${row.feetMinusGrassM} feet-blade=${row.feetMinusBladeM} phys-cpu=${row.physMinusCpuM} grass-phys=${row.grassMinusPhysM} grass-cpu=${row.grassMinusCpuM} onGround=${row.onGround} held=${row.held} settled=${row.settled}${row.settled ? '' : ' TIMEOUT'} settleMs=${row.settleMs} covers=${row.colliderCovers}`)
}

// ---------------------------------------------------------------- verdict
const measured = rows.filter((r) => Number.isFinite(r.hoverM))
expect(`all ${DISTANCES_M.length} distances measured a settled player through every source`, measured.length === DISTANCES_M.length,
  `measured=${measured.length}/${DISTANCES_M.length} ` + rows.map((r) => `d=${r.d}:${r.settled ? 'ok' : 'timeout'}`).join(' '))
for (const r of rows) {
  expect(`d=${r.d}m: the player actually reached the rung`, r.reached === true,
    `player landed ${r.reachedM} m from (${r.x},${r.z}), budget ${RUNG_REACHED_M} m`)
}
for (const r of rows) {
  expect(`d=${r.d}m: the player rests where the collider says it must (within ${ACCEPT_HOVER_M} m)`, r.reached === true && Number.isFinite(r.hoverM) && Math.abs(r.hoverM) <= ACCEPT_HOVER_M,
    `hover=${r.hoverM} m (playerY=${r.playerY} standY=${r.standY} physY=${r.physY})`)
}
for (const r of rows) {
  expect(`d=${r.d}m: the player's feet are within ${ACCEPT_PLAYER_GRASS_M} m of the ground grass is placed on`, r.reached === true && Number.isFinite(r.feetMinusGrassM) && Math.abs(r.feetMinusGrassM) <= ACCEPT_PLAYER_GRASS_M,
    `feet-grass=${r.feetMinusGrassM} m (feetY=${r.feetY} grassCellY=${r.grassCellY} physY=${r.physY})`)
}
// The growth test: the row's leading hypothesis predicts the divergence grows with distance.
const growthOf = (field) => {
  const near = rows.find((r) => r.d === Math.min(...DISTANCES_M))
  const far = rows.find((r) => r.d === Math.max(...DISTANCES_M))
  if (!near || !far || !Number.isFinite(near[field]) || !Number.isFinite(far[field])) return NaN
  return Math.abs(far[field]) - Math.abs(near[field])
}
for (const field of ['feetMinusGrassM', 'grassMinusPhysM', 'grassMinusCpuM', 'physMinusCpuM', 'hoverM']) {
  const near = rows.find((r) => r.d === Math.min(...DISTANCES_M))
  const far = rows.find((r) => r.d === Math.max(...DISTANCES_M))
  console.log(`GROWTH ${field}: ${near ? near.d : '?'}m=${near ? near[field] : 'n/a'} -> ${far ? far.d : '?'}m=${far ? far[field] : 'n/a'} (|delta| growth ${growthOf(field).toFixed(4)} m) ladder=[${rows.map((r) => r[field]).join(', ')}]`)
}
// ---------------------------------------------------------------- browser arm
// The node arm sees the collider, the CPU solve and placement. It cannot see the two things the
// owner is actually looking at: the RENDERED MESH and the CAMERA. Both live in the page, so the
// browser arm reads them at one instant and at the player's own (x,z).
let browserRows = null
if (process.env.SPOINT_GPU_WITNESS === '1') {
  const { withGpuPage } = await import(href('scripts/lib/gpu-eval.mjs'))
  const BPORT = Number(arg('port', 8090))
  const url = `http://localhost:${BPORT}/?singleplayer&world=${encodeURIComponent(WORLD)}&nc=${Date.now()}`
  const script = `
const __t = window.__terrain
if (!__t || !__t.frame) return { __error: 'no terrain frame in the page' }
const __f = __t.frame
const __c = window.__client
const __ls = __c && __c.getLocalState ? __c.getLocalState() : null
if (!__ls || !__ls.position) return { __error: 'no local player state' }
const __cam = window.__camera
const __cw = new (window.__app && window.__app.THREE ? window.__app.THREE.Vector3 : Object)()
let __camY = null
if (__cam) { if (typeof __cw.setFromMatrixPosition === 'function') { __cw.setFromMatrixPosition(__cam.matrixWorld); __camY = __cw.y } else __camY = __cam.position ? __cam.position.y : null }
const __px = __ls.position[0], __py = __ls.position[1], __pz = __ls.position[2]
const __rm = typeof __f.renderMeshHeightAtLocal === 'function' ? __f.renderMeshHeightAtLocal(__px, __pz) : null
const __cpu = __f.groundHeightLocal(__px, __pz)
// Live grass: the nearest placed blade's own y out of the instancer, not a second copy of the law.
let __gY = null, __gD = null, __gn = 0
const __g = window.__grass
if (__g && __g._cells) {
  for (const __cell of __g._cells.values()) {
    if (!__cell || !__cell.xf || !__cell.on) continue
    const __n = __cell.on.length
    for (let __i = 0; __i < __n; __i++) {
      if (__cell.on[__i] !== 1) continue
      const __o = __i * 9
      const __d = Math.hypot(__cell.xf[__o] - __px, __cell.xf[__o + 2] - __pz)
      if (__d > 3) continue
      __gn++
      if (__gD === null || __d < __gD) { __gD = __d; __gY = __cell.xf[__o + 1] }
    }
  }
}
const __fo = window.__floatingOrigin
return {
  backend: __f.renderMeshHeightAtLocal ? 'renderMeshHeightAtLocal' : 'none',
  playerY: __py, playerX: __px, playerZ: __pz,
  cameraLocalY: __cam ? (__cam.position ? __cam.position.y : null) : null,
  cameraWorldY: __camY,
  camPosLocal: __cam ? [__cam.position.x, __cam.position.y, __cam.position.z] : null,
  floatingOrigin: __fo ? (__fo.offset ? [__fo.offset.x, __fo.offset.y, __fo.offset.z] : (__fo.origin ? [__fo.origin.x, __fo.origin.y, __fo.origin.z] : Object.keys(__fo).slice(0, 12))) : null,
  renderedMeshY: __rm, cpuY: __cpu, grassY: __gY, grassDistM: __gD, grassBladesNear: __gn,
  onGround: !!__ls.onGround,
}
`
  try {
    browserRows = await withGpuPage({ port: BPORT, url, backend: 'webgpu' }, async (run) => run(script))
    console.log(`BROWSER: ${JSON.stringify(browserRows)}`)
    if (browserRows && Number.isFinite(browserRows.playerY)) {
      const d = {
        playerMinusRenderedM: Number.isFinite(browserRows.renderedMeshY) ? +(browserRows.playerY - browserRows.renderedMeshY).toFixed(4) : NaN,
        grassMinusRenderedM: Number.isFinite(browserRows.grassY) && Number.isFinite(browserRows.renderedMeshY) ? +(browserRows.grassY - browserRows.renderedMeshY).toFixed(4) : NaN,
        playerMinusGrassM: Number.isFinite(browserRows.grassY) ? +(browserRows.playerY - browserRows.grassY).toFixed(4) : NaN,
        renderedMinusCpuM: Number.isFinite(browserRows.renderedMeshY) && Number.isFinite(browserRows.cpuY) ? +(browserRows.renderedMeshY - browserRows.cpuY).toFixed(4) : NaN,
      }
      console.log(`BROWSER DELTAS: player-renderedMesh=${d.playerMinusRenderedM} grass-renderedMesh=${d.grassMinusRenderedM} player-grass=${d.playerMinusGrassM} renderedMesh-cpu=${d.renderedMinusCpuM}`)
      expect('the browser arm read a rendered mesh height and a live grass blade',
        Number.isFinite(browserRows.renderedMeshY) && Number.isFinite(browserRows.grassY),
        `renderedMeshY=${browserRows.renderedMeshY} grassY=${browserRows.grassY} bladesWithin3m=${browserRows.grassBladesNear}`)
      expect(`the player's feet are within ${ACCEPT_PLAYER_GRASS_M} m of the rendered mesh ground`,
        Number.isFinite(d.playerMinusRenderedM) && Math.abs(d.playerMinusRenderedM - rows[0].standingOffsetM) <= ACCEPT_PLAYER_GRASS_M,
        `playerY-renderedMeshY=${d.playerMinusRenderedM} m against a standing offset of ${rows[0].standingOffsetM} m`)
    }
  } catch (e) {
    console.log(`BROWSER: NOT MEASURED -- ${(e && e.message) || e}`)
  }
} else {
  console.log('BROWSER: NOT MEASURED -- set SPOINT_GPU_WITNESS=1 to add the rendered-mesh and camera arm (reaches the page, so it is off the gpu-free path)')
}
try { ws.close() } catch {}
try { await server.stop() } catch (e) { console.log(`server.stop: ${(e && e.message) || e}`) }
await sleep(200)

const failed = checks.filter((c) => !c.ok).length
for (const c of checks) if (!c.ok) console.log('FAIL: ' + c.check + ': ' + c.detail)
console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'} world=${WORLD} -- ${checks.length} check(s), ${failed} failure(s), hover=[${rows.map((r) => r.hoverM).join(', ')}] player-grass=[${rows.map((r) => r.playerMinusGrassM).join(', ')}]`)
process.exit(failed ? 1 : 0)
