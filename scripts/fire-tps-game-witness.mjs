#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createNetServer } from 'node:net'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOLD_MS = Number(process.argv[2] || 9000)

const { createServer } = await import('../src/sdk/server.js')
const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')
const { AppContext } = await import('../src/apps/AppContext.js')
const { loadWorldModule } = await import('../src/sdk/WorldLocator.js')
const { createPlanetFrame } = await import('../src/terrain/PlanetFrame.js')

const out = []
const say = (...parts) => { const line = parts.join(' '); out.push(line); console.log(line) }
const fmt = v => (v == null || !Number.isFinite(Number(v)) ? String(v) : Number(v).toFixed(2))

function freePort() {
  return new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, ms, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25) }
  say(`  !! timed out waiting for ${label}`)
  return false
}

const spies = { defineFireCalls: 0, fire: null, combatSpecKeys: null }
const origDefineFire = AppContext.prototype.defineFire
AppContext.prototype.defineFire = function (spec = {}) {
  spies.defineFireCalls++
  const fire = origDefineFire.call(this, spec)
  if (!spies.fire) spies.fire = fire
  return fire
}
const origDefineCombat = AppContext.prototype.defineCombat
AppContext.prototype.defineCombat = function (spec = {}) {
  spies.combatSpecKeys = Object.keys(spec).sort().join(',')
  return origDefineCombat.call(this, spec)
}

function worldWith({ baseWorld, enabled, weather }) {
  const entities = baseWorld.entities.map(e => e.id === 'tps-game' ? { ...e, config: { ...(e.config || {}), fire: { enabled } } } : e)
  const terrain = weather ? { ...baseWorld.terrain, weather } : baseWorld.terrain
  return { ...baseWorld, terrain, entities }
}

async function runOnce({ enabled, weather, label }) {
  spies.defineFireCalls = 0
  spies.fire = null
  spies.combatSpecKeys = null
  const port = await freePort()
  const baseWorld = await loadWorldModule(resolve(SDK_ROOT, 'apps', 'world', 'tps-game.js'))
  const worldDef = worldWith({ baseWorld, enabled, weather })
  const server = await createServer({
    port, tickRate: worldDef.tickRate || 60,
    appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src', 'stdlib-apps')],
    sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [],
    storageDir: resolve(SDK_ROOT, 'data', 'fire-tps-witness'),
  })
  const transcript = []
  const conn = server.connections
  const origBroadcast = conn.broadcast.bind(conn)
  conn.broadcast = (type, payload, ...rest) => { transcript.push({ dir: 'all', type, payload }); return origBroadcast(type, payload, ...rest) }
  if (typeof conn.send === 'function') {
    const origSend = conn.send.bind(conn)
    conn.send = (id, type, payload, ...rest) => { transcript.push({ dir: 'one', to: id, type, payload }); return origSend(id, type, payload, ...rest) }
  }
  await server.loadWorld(worldDef)
  await server.start()
  const url = `ws://127.0.0.1:${port}/ws`
  const clients = [0, 1].map(() => new PhysicsNetworkClient({ url, predictionEnabled: false, smoothInterpolation: false, webTransport: { enabled: false } }))
  await Promise.all(clients.map(c => c.connect()))
  await until(() => server.playerManager.getConnectedPlayers().length === 2, 20000, 'two players to join')
  const players = server.playerManager.getConnectedPlayers()
  const shooterId = players[0].id, victimId = players[1].id
  clients[0].startInputLoop(() => ({ yaw: 0, pitch: 0 }))
  clients[1].startInputLoop(() => ({ yaw: 0, pitch: 0 }))

  const stand = (id, pos) => { const p = server.playerManager.getPlayer(id); if (!p) return; p.state.position[0] = pos[0]; p.state.position[1] = pos[1]; p.state.position[2] = pos[2]; server.physicsIntegration.setPlayerPosition(id, pos) }
  const posOf = id => server.playerManager.getPlayer(id)?.state?.position
  const spawn = worldDef.spawnPoint || [0, 2, 0]
  stand(shooterId, [spawn[0], spawn[1], spawn[2]])
  stand(victimId, [spawn[0] + 6, spawn[1], spawn[2]])
  await sleep(400)

  const fire = () => spies.fire
  const rowsOf = type => transcript.filter(t => t.payload && t.payload.type === type)
  const shootRay = (origin, dir) => {
    const len = Math.hypot(dir[0], dir[1], dir[2])
    clients[0].sendFire({ origin, direction: [dir[0] / len, dir[1] / len, dir[2] / len], viewErrM: 0 })
  }
  const shootAtGround = () => {
    const p = posOf(shooterId)
    shootRay([p[0], p[1] + 1.6, p[2]], [0.35, -0.94, 0])
  }
  const shootAtVictim = () => {
    const a = posOf(shooterId), b = posOf(victimId)
    const o = [a[0], a[1] + 1.6, a[2]]
    shootRay(o, [b[0] - o[0], b[1] + 0.9 - o[1], b[2] - o[2]])
  }

  shootAtGround()
  await sleep(700)
  const impact = rowsOf('world_hit').slice(-1)[0]?.payload?.pos ?? null
  const activeAfterShot = fire() ? fire().activeCount : -1
  const ignitionsAfterShot = fire() ? fire().stats?.ignitions ?? 0 : -1

  const ground = (x, z) => { const g = server.physics.terrainHeightAt(x, z); return Number.isFinite(g) ? g : spawn[1] }
  stand(victimId, [spawn[0] + 160, ground(spawn[0] + 160, spawn[2]) + 0.3, spawn[2]])
  const scanBurning = (span, step) => {
    const f = fire()
    const cells = []
    if (!f || !impact) return cells
    for (let dx = -span; dx <= span; dx += step) for (let dz = -span; dz <= span; dz += step) {
      const x = impact[0] + dx, z = impact[2] + dz
      if (f.stateAtLocal(x, z) === 1) cells.push([x, z, ground(x, z)])
    }
    return cells
  }
  const crossCount = (o, d, len) => {
    let n = 0
    for (let s = 0; s <= len; s += 4) if (fire().stateAtLocal(o[0] + d[0] * s, o[2] + d[2] * s) === 1) n++
    return n
  }

  let peakActive = 0
  const t0 = Date.now()
  while (Date.now() - t0 < HOLD_MS) {
    shootAtGround()
    await sleep(500)
    if (fire() && fire().activeCount > peakActive) peakActive = fire().activeCount
  }

  let blocked = null, clearShot = null, throughFireHits = null, aroundFireHits = null
  let bandCells = 0, bandLengthM = 0
  {
    const cells = scanBurning(160, 8)
    bandCells = cells.length
    if (cells.length >= 2) {
      let A = cells[0], B = cells[1], far = -1
      for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
        const d = Math.hypot(cells[i][0] - cells[j][0], cells[i][1] - cells[j][1])
        if (d > far) { far = d; A = cells[i]; B = cells[j] }
      }
      bandLengthM = far
      const ux = far > 0 ? (B[0] - A[0]) / far : 1, uz = far > 0 ? (B[1] - A[1]) / far : 0
      const EXT = 40
      const ax = A[0] - ux * EXT, az = A[1] - uz * EXT
      const bx = B[0] + ux * EXT, bz = B[1] + uz * EXT
      const aPos = [ax, ground(ax, az) + 0.2, az]
      const bPos = [bx, ground(bx, bz) + 0.2, bz]
      stand(shooterId, aPos)
      stand(victimId, bPos)
      await sleep(500)
      const o = [aPos[0], aPos[1] + 1.6, aPos[2]]
      const dx = bPos[0] - o[0], dy = bPos[1] + 0.9 - o[1], dz = bPos[2] - o[2]
      const len = Math.hypot(dx, dy, dz)
      const dir = [dx / len, dy / len, dz / len]
      blocked = { crossedBurning: crossCount(o, dir, len), distanceM: +len.toFixed(1), depth: +fire().smokeDepth(o, dir, len).toFixed(3), blocked: fire().rayBlocked(o, dir, len) }
      const hitsA = rowsOf('hit').length
      shootAtVictim()
      await sleep(900)
      throughFireHits = rowsOf('hit').length - hitsA

      const px = -uz, pz = ux
      const cx2 = aPos[0] + px * len, cz2 = aPos[2] + pz * len
      const cPos = [cx2, ground(cx2, cz2) + 0.2, cz2]
      stand(victimId, cPos)
      await sleep(500)
      const ex = cPos[0] - o[0], ey = cPos[1] + 0.9 - o[1], ez = cPos[2] - o[2]
      const l2 = Math.hypot(ex, ey, ez)
      const d2 = [ex / l2, ey / l2, ez / l2]
      clearShot = { crossedBurning: crossCount(o, d2, l2), distanceM: +l2.toFixed(1), depth: +fire().smokeDepth(o, d2, l2).toFixed(3), blocked: fire().rayBlocked(o, d2, l2) }
      const hitsB = rowsOf('hit').length
      shootAtVictim()
      await sleep(900)
      aroundFireHits = rowsOf('hit').length - hitsB
    }
  }

  const healthBeforeBurn = server.playerManager.getPlayer(victimId)?.state?.health ?? null
  let minHealth = healthBeforeBurn, burnSamples = 0, burnCell = null
  const deathsBefore = rowsOf('fire_death').length
  const t1 = Date.now()
  while (Date.now() - t1 < 7000) {
    const cells = scanBurning(96, 8)
    if (cells.length > 0) {
      burnCell = cells[Math.floor(cells.length / 2)]
      stand(victimId, [burnCell[0], burnCell[2] + 0.3, burnCell[1]])
      burnSamples++
    }
    const h = server.playerManager.getPlayer(victimId)?.state?.health ?? null
    if (h != null && (minHealth == null || h < minHealth)) minHealth = h
    await sleep(250)
  }
  const healthAfterBurn = server.playerManager.getPlayer(victimId)?.state?.health ?? null
  const fireDamage = healthBeforeBurn != null && minHealth != null ? healthBeforeBurn - minHealth : 0
  const burnDeaths = rowsOf('fire_death').length - deathsBefore

  const types = {}
  for (const t of transcript) { const k = String(t.payload?.type ?? t.type); types[k] = (types[k] || 0) + 1 }
  const fireTypes = Object.keys(types).filter(k => k.startsWith('fire')).sort()
  const otherTypes = Object.keys(types).filter(k => !k.startsWith('fire')).sort()

  for (const c of clients) { try { c.stopInputLoop?.(); c.disconnect?.() } catch {} }
  try { server.tickSystem?.stop?.() } catch {}
  try { await server.stop?.() } catch {}

  return {
    label, enabled, weather: weather ? weather.type + '@' + weather.intensity : 'as shipped',
    defineFireCalls: spies.defineFireCalls, combatSpecKeys: spies.combatSpecKeys, fireConstructed: !!spies.fire,
    impact, activeAfterShot, ignitionsAfterShot, peakActive,
    healthBeforeBurn, healthAfterBurn, minHealth, fireDamage, burnDeaths,
    bandCells, bandLengthM: +bandLengthM.toFixed(1), burnSamples,
    burnCell: burnCell ? burnCell.map(v => +Number(v).toFixed(2)) : null,
    fireWireRows: rowsOf('fire').length,
    burnRows: rowsOf('fire_burn').length, burnEndRows: rowsOf('fire_burn_end').length, deathRows: rowsOf('fire_death').length,
    fireTypes, otherTypes,
    blocked, clearShot, throughFireHits, aroundFireHits,
    totalRows: transcript.length,
  }
}

function report(r) {
  say(`-- ${r.label}`)
  say(`  weather ${r.weather}; defineFire calls ${r.defineFireCalls}; fire instance constructed ${r.fireConstructed}`)
  say(`  combat spec keys: ${r.combatSpecKeys}`)
  say(`  first ground shot: impact ${JSON.stringify(r.impact?.map(v => +v.toFixed(2)))}, ${r.activeAfterShot} active cell(s), ${r.ignitionsAfterShot} ignition(s)`)
  say(`  peak active cells ${r.peakActive}; burning band ${r.bandCells} cell(s) spanning ${r.bandLengthM} m`)
  say(`  victim health ${fmt(r.healthBeforeBurn)} -> min ${fmt(r.minHealth)} over 7 s on freshly burning cells (${r.burnSamples} rescans, fire damage ${fmt(r.fireDamage)}, fire_death ${r.burnDeaths})`)
  say(`  broadcast rows ${r.totalRows}: fire wire rows ${r.fireWireRows}, fire_burn ${r.burnRows}, fire_burn_end ${r.burnEndRows}, fire_death ${r.deathRows}`)
  say(`  fire-typed payload types: ${JSON.stringify(r.fireTypes)}`)
  say(`  LOS through the burning band:  ${JSON.stringify(r.blocked)}`)
  say(`  LOS rotated 90 deg, same span: ${JSON.stringify(r.clearShot)}`)
  say(`  aimed shots that landed: through the fire ${r.throughFireHits}, around the fire ${r.aroundFireHits}`)
  say(`  non-fire payload types: ${JSON.stringify(r.otherTypes)}`)
}

const NAV_ONLY = process.argv.slice(2).includes('nav')
say('== fire tps-game integration witness (real server, real clients, real tps-game world) ==')
if (!NAV_ONLY) {
const off = await runOnce({ enabled: false, label: 'flag off (exactly as shipped in apps/world/tps-game.js)' })
say('')
report(off)
say('')
const onRain = await runOnce({ enabled: true, label: 'flag on, weather as shipped (rain 0.6)' })
say('')
report(onRain)
say('')
const onClear = await runOnce({ enabled: true, weather: { serverAuthoritative: true, type: 'clear', intensity: 0, particleCount: 0 }, label: 'flag on, weather clear' })
say('')
report(onClear)
}

say('')
say('== navCostAt with and without fire (real AppContext, real defineFire) ==')
{
  const { createFireLattice } = await import('../src/shared/fire/fireLattice.js')
  const { VEG } = await import('../src/terrain/VegPlacement.js')
  const { latticeFor } = await import('../src/terrain/PlacementChart.js')
  const { FIRE_STATE } = await import('../src/shared/fire/fireKernel.js')
  const { FIRE_SPEC } = await import(pathToFileURL(resolve(SDK_ROOT, 'apps', 'tps-game', 'shared.js')).href)

  const frame = createPlanetFrame({ sampler: { radius: 63600, heightAt: () => 0 }, anchorDir: [0, 1, 0], offsetY: 0, reliefScale: 0.001 })
  const lattice = createFireLattice(latticeFor({ radius: 63600 }, VEG), 2)
  const HOME_I = lattice.cellsPerFace >> 1, HOME_J = HOME_I
  const centre = [0, 0, 0]
  lattice.cellCentreDir(2, HOME_I, HOME_J, centre)
  const du = centre[0] * frame.up[0] + centre[1] * frame.up[1] + centre[2] * frame.up[2]
  const t = frame.radius + frame.anchorHeight
  const px = (centre[0] * frame.east[0] + centre[1] * frame.east[1] + centre[2] * frame.east[2]) / du * t
  const pz = (centre[0] * frame.north[0] + centre[1] * frame.north[1] + centre[2] * frame.north[2]) / du * t

  const entity = { id: 'nav-probe', position: [px, 0, pz] }
  const runtime = {
    _physics: { _planetFrame: frame, terrainHeightAt: () => 0, seaLevelAt: () => 0, _terrainStreamer: {} },
    currentTick: 0, deltaTime: 1 / 60, elapsed: 0,
    getPlayers: () => [], getPlayerById: () => null, getNearestPlayer: () => null,
    sendToPlayer: () => {}, broadcastToPlayers: () => {},
  }
  const ctx = new AppContext(entity, runtime)
  const N = 200000
  const timeIt = fn => {
    for (let w = 0; w < 2; w++) for (let i = 0; i < N; i++) fn(px + (i % 97), pz + (i % 89))
    let best = Infinity
    for (let b = 0; b < 7; b++) {
      const s = process.hrtime.bigint()
      for (let i = 0; i < N; i++) fn(px + (i % 97), pz + (i % 89))
      const ns = Number(process.hrtime.bigint() - s) / N
      if (ns < best) best = ns
    }
    return best
  }
  const baseline = (x, z) => {
    const kind = ctx.terrainKindAt(x, z)
    if (kind === 'road') return 0.5
    if (kind === 'river') return 3
    return 1
  }
  const floorNs = timeIt(() => 0)
  const noFireNs = timeIt((x, z) => ctx.navCostAt(x, z))
  const baselineNs = timeIt(baseline)
  say(`harness floor (empty closure) ${floorNs.toFixed(1)} ns/call`)
  say(`no fire registered: navCostAt ${ctx.navCostAt(px, pz)} at ${noFireNs.toFixed(1)} ns/call; the old body alone ${baselineNs.toFixed(1)} ns/call`)
  say(`  added cost when no fire exists: ${(noFireNs - baselineNs).toFixed(1)} ns/call (budget 100 ns; harness floor ${floorNs.toFixed(1)})`)

  const fire = ctx.defineFire(FIRE_SPEC)
  const idleNs = timeIt((x, z) => ctx.navCostAt(x, z))
  const idleStateNs = timeIt((x, z) => fire.stateAtLocal(x, z))
  const localToDirNs = timeIt((x, z) => frame.localToDir(x, z, 0))
  say(`fire registered, nothing burning: navCostAt ${ctx.navCostAt(px, pz)} at ${idleNs.toFixed(1)} ns/call`)
  say(`  breakdown: fire.stateAtLocal ${idleStateNs.toFixed(1)} ns/call, frame.localToDir alone ${localToDirNs.toFixed(1)} ns/call`)
  fire.igniteCell(2, HOME_I, HOME_J, 1)
  let ticksToBurning = -1
  for (let tick = 1; tick <= 4 * FIRE_SPEC.stepTicks; tick++) {
    runtime.currentTick = tick
    fire.tick(1 / 60)
    if (fire.stateAtLocal(px, pz) === FIRE_STATE.BURNING) { ticksToBurning = tick; break }
  }
  const burningState = fire.stateAtLocal(px, pz)
  const burningCost = ctx.navCostAt(px, pz)
  const burningNs = timeIt((x, z) => ctx.navCostAt(x, z))
  const burningStateNs = timeIt((x, z) => fire.stateAtLocal(x, z))
  say(`ignited cell under the probe: stateAtLocal ${burningState} (BURNING=${FIRE_STATE.BURNING}) after ${ticksToBurning} tick(s) -> navCostAt ${burningCost} at ${burningNs.toFixed(1)} ns/call (stateAtLocal alone ${burningStateNs.toFixed(1)}), active ${fire.activeCount}`)
  for (let tick = ticksToBurning + 1; tick <= ticksToBurning + 40 * FIRE_SPEC.stepTicks; tick++) { runtime.currentTick = tick; fire.tick(1 / 60) }
  const charredState = fire.stateAtLocal(px, pz)
  const charredCost = ctx.navCostAt(px, pz)
  say(`after 40 fire steps: stateAtLocal ${charredState} (BURNT=${FIRE_STATE.BURNT}) -> navCostAt ${charredCost}; unburnt neighbour navCostAt ${ctx.navCostAt(px + 4000, pz)}`)
  say(`fire cell ${lattice.cellM.toFixed(2)} m; probe at chart-local ${px.toFixed(0)},${pz.toFixed(0)}`)
}

say('')
say('== witness complete ==')
process.exit(0)
