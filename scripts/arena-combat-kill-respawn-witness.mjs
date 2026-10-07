#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'
import { assertGpu } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'

process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
process.env.WORLD = process.env.WORLD || 'arena-combat'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const PORT = args.port || '3137'
const GPU_MODE = args.gpu || 'accelerated'
const WANT_SOFTWARE = GPU_MODE === 'software' || GPU_MODE === 'swiftshader' || GPU_MODE === 'none'
const WANT_VENDOR = WANT_SOFTWARE || GPU_MODE === 'accelerated' ? null : GPU_MODE
const FORCE_WEBGL_BACKEND = args['force-webgl'] === 'true'
const READY_TIMEOUT_MS = Number(args.timeout || 900000)
const ROOM_TIMEOUT_MS = Number(args['room-timeout'] || 600000)
const KILL_TIMEOUT_MS = Number(args['kill-timeout'] || 300000)
const RESPAWN_TIMEOUT_MS = Number(args['respawn-timeout'] || 120000)
const SEPARATE_MS = Number(args['separate-ms'] || 1600)
const USE_OBSERVER = args.clients !== '2'
const EXPECTED_PLAYERS = Number(args['expected-players'] || (USE_OBSERVER ? 3 : 2))
const SPAWN_TOLERANCE_M = Number(args['spawn-tolerance'] || 1.5)
const VIEW_W = Number(args['view-width'] || 320)
const VIEW_H = Number(args['view-height'] || 180)
const TELEPORT_OFFSET_M = Number(args['teleport-offset'] || 6)
const RELEVANCE_RADIUS_M = Number(args['relevance-radius'] || 200)
const CACHE_BUSTER = String(Date.now())

const failures = []
const allClients = []
function check(ok, message) {
  if (ok) return true
  failures.push(message)
  return false
}
function dumpClient(c, limit = 12) {
  if (!c || !c.consoleEntries) return
  const errors = c.consoleEntries.filter(e => e.level === 'error' || e.level === 'exception')
  console.log(`[arena-combat] ${c.label} console: entries=${c.consoleEntries.length} errors=${errors.length} pageErrors=${c.pageErrors.length} failedRequests=${c.failedRequests.length} cancelledRequests=${c.cancelledRequests.length}`)
  for (const e of errors.slice(0, limit)) console.log(`  [${c.label}][${e.level}] ${e.text.slice(0, 600)}`)
  for (const e of c.pageErrors.slice(0, limit)) console.log(`  [${c.label}][pageerror] ${String(e).slice(0, 300)}`)
  for (const r of c.failedRequests.slice(0, limit)) console.log(`  [${c.label}][request] ${r.url} ${r.text}`)
  for (const w of c.webSockets || []) console.log(`  [${c.label}][ws] ${w.url} closed=${w.closedAt ? 'yes' : 'no'}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const CONNECTED = 'window.__app && window.__app.client && window.__app.client.playerId != null && window.__app.engine && window.__app.engine._tps && window.__app.client.state && window.__app.client.state.players.length >= 1'
const PLAYABLE = 'window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady && window.__app.client && window.__app.client.playerId != null'
const CANCELLED_REQUEST_ERROR_TEXTS = new Set(['net::ERR_ABORTED'])

function textOf(entry) {
  const list = entry?.args || []
  return list.map(a => a?.description || (a?.value === undefined ? '' : String(a.value))).join(' ')
}

async function makeClient(browser, label) {
  const context = await browser.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const consoleEntries = []
  const pageErrors = []
  const failedRequests = []
  const cancelledRequests = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  page.on('Runtime.consoleAPICalled', p => consoleEntries.push({ level: p?.type || 'unknown', text: textOf(p) }))
  page.on('Runtime.exceptionThrown', p => consoleEntries.push({ level: 'exception', text: p?.exceptionDetails?.exception?.description || p?.exceptionDetails?.text || 'exception' }))
  await page.enableDomain('Network.enable')
  page.on('Network.loadingFailed', p => (CANCELLED_REQUEST_ERROR_TEXTS.has(p?.errorText) ? cancelledRequests : failedRequests).push({ url: p?.requestId || 'unknown-request', text: p?.errorText || 'failed' }))
  page.on('Network.responseReceived', p => {
    const status = p?.response?.status || 0
    if (status >= 400) failedRequests.push({ url: p?.response?.url, text: 'HTTP ' + status })
  })
  const webSockets = []
  page.on('Network.webSocketCreated', p => {
    const row = { url: p?.url || 'unknown-url', at: Date.now(), closedAt: 0 }
    webSockets.push(row)
    console.log(`[arena-combat] ${label} websocket opened ${row.url}`)
  })
  page.on('Network.webSocketClosed', () => {
    const row = [...webSockets].reverse().find(w => !w.closedAt)
    if (row) row.closedAt = Date.now()
  })
  const rawEvaluate = page.evaluate.bind(page)
  page.evaluate = (fn, ...rest) => Promise.race([
    rawEvaluate(fn, ...rest),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`page.evaluate did not answer within ${EVAL_STALL_MS}ms -- the page main thread is blocked`)), EVAL_STALL_MS)),
  ])
  return { label, page, consoleEntries, pageErrors, failedRequests, cancelledRequests, webSockets }
}

const EVAL_STALL_MS = Number(args['eval-stall'] || 180000)
const EVAL_STALL_LIMIT = 3

async function evaluateOrThrow(page, fn, ms) {
  return Promise.race([
    Promise.resolve(page.evaluate(fn)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`page.evaluate did not answer within ${ms}ms -- the page main thread is blocked`)), ms)),
  ])
}

async function waitFor(page, label, expr, ms) {
  const t0 = Date.now()
  let lastLog = 0
  let stalls = 0
  while (Date.now() - t0 < ms) {
    const waited = Date.now() - t0
    let ok = false
    try {
      ok = await page.evaluate(`!!(${expr})`)
      stalls = 0
    } catch (e) {
      stalls++
      console.log(`[arena-combat] ${label} wait probe stalled ${stalls} of ${EVAL_STALL_LIMIT} after ${(waited / 1000).toFixed(0)}s: ${e.message}`)
      if (stalls >= EVAL_STALL_LIMIT) return null
      continue
    }
    if (ok) return waited
    if (waited - lastLog > 30000) {
      lastLog = waited
      console.log(`[arena-combat] ${label} still waiting after ${(waited / 1000).toFixed(0)}s for ${expr}`)
    }
    await sleep(250)
  }
  return null
}

function readRoom() {
  const app = window.__app
  const c = app && app.client
  if (!c || !c.state || !Array.isArray(c.state.players)) return null
  return {
    playerId: c.playerId ?? null,
    tick: c.currentTick ?? null,
    players: c.state.players.map(p => ({ id: p.id, health: p.health ?? null, position: p.position ? [p.position[0], p.position[1], p.position[2]] : null })),
  }
}

function readTps() {
  const app = window.__app
  const tps = app && app.engine && app.engine._tps
  if (!tps) return null
  const juice = window.__funJuice
  return {
    playerId: (app.client && app.client.playerId) ?? null,
    kills: tps.kills ?? 0,
    ammo: tps.ammo ?? null,
    respawnFadeAt: tps.respawnFadeAt ?? 0,
    spawnShieldUntil: tps.spawnShieldUntil ?? 0,
    deathKiller: tps.deathKiller ?? null,
    funKill: juice ? juice.kill : null,
    funHit: juice ? juice.hit : null,
  }
}

function aimAtTarget(targetId) {
  const app = window.__app
  const c = app && app.client
  if (!c || !c.state || !app.cam) return null
  const me = c.state.players.find(p => p.id === c.playerId)
  const target = c.state.players.find(p => p.id === targetId)
  if (!me || !target || !me.position || !target.position) return null
  const eye = [me.position[0], me.position[1] + 0.9, me.position[2]]
  const want = [target.position[0] - eye[0], target.position[1] + 0.9 - eye[1], target.position[2] - eye[2]]
  const wl = Math.hypot(want[0], want[1], want[2])
  if (!(wl > 0.001)) return null
  const w = [want[0] / wl, want[1] / wl, want[2] / wl]
  const clamp = v => Math.max(-1, Math.min(1, v))
  const wantYaw = Math.atan2(w[0], w[2])
  const wantPitch = Math.asin(clamp(w[1]))
  let dir = app.cam.getAimDirection(me.position)
  for (let i = 0; i < 24; i++) {
    const dot = dir[0] * w[0] + dir[1] * w[1] + dir[2] * w[2]
    if (dot > 0.999995) break
    let dYaw = wantYaw - Math.atan2(dir[0], dir[2])
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI
    const dPitch = wantPitch - Math.asin(clamp(dir[1]))
    app.cam.setVRYaw(app.cam.getVRYaw() + dYaw)
    app.cam.setVRPitch(app.cam.getVRPitch() + dPitch)
    dir = app.cam.getAimDirection(me.position)
  }
  return { dot: dir[0] * w[0] + dir[1] * w[1] + dir[2] * w[2], dir: [dir[0], dir[1], dir[2]], distance: wl }
}

function dist2d(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2])
}

async function main() {
  process.env.PORT = PORT
  const { AppRuntime } = await import('../src/apps/AppRuntime.js')
  let combat = null
  let appCtx = null
  const origAttachBehaviours = AppRuntime.prototype._attachBehaviours
  AppRuntime.prototype._attachBehaviours = async function (entityId, spec) {
    const out = await origAttachBehaviours.call(this, entityId, spec)
    if (!appCtx) {
      const ctx = this.contexts.get(entityId)
      if (ctx && ctx.players && ctx.network) appCtx = ctx
    }
    if (!combat) {
      const list = this._behaviours.get(entityId)
      if (list) for (const entry of list) if (entry.name === 'combat') {
        combat = entry.api
        const owner = this.contexts.get(entityId)
        if (owner && owner.players) appCtx = owner
      }
    }
    return out
  }

  console.log(`[arena-combat] booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  const base = `http://localhost:${PORT}`
  console.log('[arena-combat] server up.')

  const joinLog = []
  const _addPlayer = server.playerManager.addPlayer.bind(server.playerManager)
  server.playerManager.addPlayer = (transport, opts) => {
    const id = _addPlayer(transport, opts)
    const row = { at: Date.now(), op: 'add', id, type: transport && transport.type, probe: transport && transport.probeOnly === true }
    joinLog.push(row)
    console.log(`[arena-combat] server add player ${id} transport=${row.type} probe=${row.probe}`)
    return id
  }
  const _removePlayer = server.playerManager.removePlayer.bind(server.playerManager)
  server.playerManager.removePlayer = (id) => {
    joinLog.push({ at: Date.now(), op: 'remove', id })
    console.log(`[arena-combat] server remove player ${id}`)
    return _removePlayer(id)
  }
  server.connections.on('disconnect', (id, reason) => console.log(`[arena-combat] server disconnect player ${id} reason=${reason || 'unnamed'}`))

  let browser
  try {
    const launchArgs = vendorLaunchArgs({ mode: GPU_MODE })
    browser = await chromium.launch({ headless: true, args: launchArgs })
    const shooter = await makeClient(browser, 'shooter')
    const victim = await makeClient(browser, 'victim')
    const observer = await makeClient(browser, 'observer')
    const clients = USE_OBSERVER ? [shooter, victim, observer] : [shooter, victim]
    for (const c of clients) allClients.push(c)
    const roles = { shooter, victim, observer: USE_OBSERVER ? observer : null }

    const url = `${base}/?multiplayer&nocache=${CACHE_BUSTER}${FORCE_WEBGL_BACKEND ? '&forcewebgl=1' : ''}`
    for (const c of clients) {
      console.log(`[arena-combat] navigating ${c.label} to ${url} ...`)
      await c.page.goto(url, { waitUntil: 'domcontentloaded' })
      c.readyMs = await waitFor(c.page, c.label, CONNECTED, READY_TIMEOUT_MS)
      console.log(`[arena-combat] ${c.label} connected=${c.readyMs === null ? 'UNREACHED' : c.readyMs + 'ms'}`)
      if (c.readyMs === null) failures.push(`${c.label} never reached connected-and-ready within ${READY_TIMEOUT_MS}ms`)
      c.playable = await c.page.evaluate(`!!(${PLAYABLE})`).catch(() => false)
      c.firstRoom = await c.page.evaluate(readRoom).catch(() => null)
      console.log(`[arena-combat] ${c.label} loadingMachineReady=${c.playable}`)
      if (c.firstRoom) console.log(`[arena-combat] ${c.label} first snapshot: self=${c.firstRoom.playerId} ids=${JSON.stringify(c.firstRoom.players.map(p => p.id))} includesSelf=${c.firstRoom.players.some(p => p.id === c.firstRoom.playerId)}`)
    }

    const gpu = await assertGpu(shooter.page, { requireAccelerated: !WANT_SOFTWARE, expectVendor: args['expect-vendor'] || WANT_VENDOR })
      .catch(e => { throw new Error(`gpu arm "${GPU_MODE}" launched with ${JSON.stringify(launchArgs)} but the session measured: ${e.message}`) })
    console.log(`[arena-combat] rasterizer=${gpu.rasterizer} gpu=${gpu.haystack || 'none'} gpuMode=${GPU_MODE} forceWebglBackend=${FORCE_WEBGL_BACKEND}`)
    check(gpu.rasterizer === (WANT_SOFTWARE ? 'software' : 'accelerated'), `the requested ${GPU_MODE} rasterizer was not the one measured: ${gpu.rasterizer} (${gpu.haystack || 'no renderer strings'})`)
    for (const c of clients) {
      c.rendererInfo = await c.page.evaluate(() => window.__rendererInfo || null).catch(() => null)
      console.log(`[arena-combat] ${c.label} renderer=${JSON.stringify(c.rendererInfo)}`)
    }

    for (const c of clients) {
      const tps = await c.page.evaluate(readTps).catch(() => null)
      c.tpsLoaded = !!tps
      check(c.tpsLoaded, `${c.label} has no engine._tps, so the tps-game client module that sends fire requests is not loaded and no shot can be driven`)
      console.log(`[arena-combat] ${c.label} tpsLoaded=${c.tpsLoaded}`)
    }

    const shooterPos = await shooter.page.evaluate(() => {
      const c = window.__client || (window.__app && window.__app.client)
      const lp = c && c.getLocalState && c.getLocalState()
      return lp && lp.position ? [lp.position[0], lp.position[1], lp.position[2]] : null
    }).catch(() => null)
    console.log(`[arena-combat] shooter position=${JSON.stringify(shooterPos)} relevanceRadius=${RELEVANCE_RADIUS_M}`)
    check(!!shooterPos, 'the shooter exposed no local position, so the room cannot be converged before the drive')

    const convergeTargets = [[roles.victim, TELEPORT_OFFSET_M]]
    if (USE_OBSERVER) convergeTargets.push([roles.observer, -TELEPORT_OFFSET_M])
    if (shooterPos) {
      for (const [c, dx] of convergeTargets) {
        const pid = c.firstRoom ? c.firstRoom.playerId : null
        const target = { x: shooterPos[0] + dx, z: shooterPos[2] }
        const placed = [shooterPos[0] + dx, shooterPos[1], shooterPos[2]]
        if (appCtx && pid != null) {
          try { appCtx.players.setPosition(pid, placed); c.teleport = { serverSetPosition: placed } } catch (e) { c.teleport = { error: 'server setPosition failed: ' + (e && e.message ? e.message : String(e)) } }
        }
        if (!appCtx || c.teleport.error) {
          c.teleport = await c.page.evaluate(async t => {
            const sp = window.__spoint
            if (!sp || typeof sp.teleport !== 'function') return { error: 'window.__spoint.teleport is not exposed on this page' }
            try { return { report: await sp.teleport(t) } } catch (e) { return { error: e && e.message ? e.message : String(e) } }
          }, target).catch(e => ({ error: 'evaluate failed: ' + (e && e.message ? e.message : String(e)) }))
        }
        console.log(`[arena-combat] ${c.label} converge ${JSON.stringify(target)} -> ${JSON.stringify(c.teleport)}`)
        check(!c.teleport.error, `${c.label} could neither be placed by the server nor teleport next to the shooter: ${c.teleport.error}`)
      }
    }

    let roomMs = null
    const roomStart = Date.now()
    while (Date.now() - roomStart < ROOM_TIMEOUT_MS) {
      const seen = []
      for (const c of clients) {
        const room = await c.page.evaluate(readRoom).catch(() => null)
        if (room) c.room = room
        seen.push(room ? room.players.map(p => p.id) : null)
      }
      const serverState = appCtx ? appCtx.players.getAll().map(p => ({ id: p.id, position: p.state && p.state.position ? [Math.round(p.state.position[0] * 100) / 100, Math.round(p.state.position[1] * 100) / 100, Math.round(p.state.position[2] * 100) / 100] : null })) : null
      const allSee = seen.every(ids => ids && ids.length === EXPECTED_PLAYERS)
      console.log(`[arena-combat] room poll ${Math.round((Date.now() - roomStart) / 1000)}s seen=${JSON.stringify(seen)} server=${JSON.stringify(serverState)}`)
      if (allSee) { roomMs = Date.now() - roomStart; break }
      let ghostSeen = false
      for (const c of clients) {
        if (c.room && c.room.players.length > EXPECTED_PLAYERS) {
          const own = clients.map(x => x.room && x.room.playerId).filter(v => v != null)
          failures.push(`${c.label} sees ${c.room.players.length} players (${JSON.stringify(c.room.players.map(p => p.id))}) in a ${EXPECTED_PLAYERS}-client room owned by ${JSON.stringify(own)} -- a socket that never joined is being spawned as a player`)
          ghostSeen = true
        }
      }
      if (ghostSeen) break
      await sleep(15000)
    }
    for (const c of clients) {
      c.roomMs = roomMs
      console.log(`[arena-combat] ${c.label} room>=${EXPECTED_PLAYERS} at ${roomMs === null ? 'UNREACHED' : roomMs + 'ms'}: players=${c.room ? c.room.players.length : 'unknown'}`)
      if (roomMs === null) failures.push(`${c.label} never saw ${EXPECTED_PLAYERS} players in the room within ${ROOM_TIMEOUT_MS}ms (saw ${c.room ? c.room.players.length : 'unknown'})`)
    }

    const ids = clients.map(c => c.room && c.room.playerId)
    console.log(`[arena-combat] playerIds shooter=${ids[0]} victim=${ids[1]} observer=${ids[2]}`)
    const named = ids.filter(v => v !== null && v !== undefined)
    check(named.length === clients.length, `not every client reported a player id: ${JSON.stringify(ids)}`)
    check(new Set(named).size === named.length, `two clients share a player id, so this is not a ${EXPECTED_PLAYERS}-player room: ${JSON.stringify(ids)}`)

    const shooterId = ids[0]
    const victimId = ids[1]

    await victim.page.evaluate(() => { if (window.__app && window.__app.cam) window.__app.cam.setVRYaw(0) })
    let separation = null
    for (let round = 0; round < 8 && (separation === null || separation < 3); round++) {
      await victim.page.keyboard.down('KeyW')
      await sleep(SEPARATE_MS)
      await victim.page.keyboard.up('KeyW')
      await sleep(1200)
      for (let i = 0; i < 10; i++) {
        const room = await shooter.page.evaluate(readRoom).catch(() => null)
        if (room) {
          const me = room.players.find(p => p.id === shooterId)
          const them = room.players.find(p => p.id === victimId)
          if (me && them && me.position && them.position) separation = dist2d(me.position, them.position)
        }
        if (separation !== null && separation >= 3) break
        await sleep(500)
      }
      console.log(`[arena-combat] separation round ${round}: ${separation === null ? 'unknown' : separation.toFixed(2) + 'm'}`)
    }
    console.log(`[arena-combat] shooter/victim separation=${separation === null ? 'unknown' : separation.toFixed(2) + 'm'}`)
    check(separation !== null && separation >= 3, `shooter and victim are only ${separation === null ? 'unknown' : separation.toFixed(2)}m apart, too close to drive a distinguishable hitscan kill`)

    await shooter.page.mouse.move(Math.round(VIEW_W / 2), Math.round(VIEW_H / 2))
    await shooter.page.mouse.down()
    let victimDeadAt = null
    const killStart = Date.now()
    let lastAim = null
    while (Date.now() - killStart < KILL_TIMEOUT_MS) {
      lastAim = await shooter.page.evaluate(aimAtTarget, victimId).catch(() => null)
      await sleep(400)
      for (const c of clients) {
        const room = await c.page.evaluate(readRoom).catch(() => null)
        if (!room) continue
        const them = room.players.find(p => p.id === victimId)
        if (them && typeof them.health === 'number') {
          if (c.minVictimHealth === undefined || them.health < c.minVictimHealth) c.minVictimHealth = them.health
          c.lastVictimHealth = them.health
        }
      }
      if (shooter.minVictimHealth !== undefined && shooter.minVictimHealth <= 0) { victimDeadAt = Date.now() - killStart; break }
    }
    await shooter.page.mouse.up()
    console.log(`[arena-combat] kill phase: victimDeadAt=${victimDeadAt === null ? 'NEVER' : victimDeadAt + 'ms'} lastAim=${JSON.stringify(lastAim)}`)
    console.log(`[arena-combat] minVictimHealth shooter=${shooter.minVictimHealth} victim=${victim.minVictimHealth} observer=${observer.minVictimHealth}`)

    check(victimDeadAt !== null, `the victim's health never reached 0 within ${KILL_TIMEOUT_MS}ms of the shooter holding fire (min seen on the shooter's client: ${shooter.minVictimHealth})`)
    check(victim.minVictimHealth !== undefined && victim.minVictimHealth <= 0, `the victim's own client never saw its health reach 0 (min ${victim.minVictimHealth}), so the victim did not observe its own death`)
    if (USE_OBSERVER) check(observer.minVictimHealth !== undefined && observer.minVictimHealth <= 0, `the observer client never saw the victim's health reach 0 (min ${observer.minVictimHealth}), so a non-participant did not observe the kill`)

    let respawn = null
    const respawnStart = Date.now()
    while (Date.now() - respawnStart < RESPAWN_TIMEOUT_MS) {
      const room = await victim.page.evaluate(readRoom).catch(() => null)
      const stillRespawning = combat ? combat.isRespawning(victimId) : null
      if (room) {
        const them = room.players.find(p => p.id === victimId)
        if (them && them.position && typeof them.health === 'number') {
          const points = combat ? combat.spawnPoints : []
          const match = points.findIndex(sp => dist2d(sp, them.position) <= SPAWN_TOLERANCE_M)
          if (them.health >= 100 && stillRespawning === false) { respawn = { health: them.health, position: them.position, spawnIndex: match, at: Date.now() - respawnStart }; break }
        }
      }
      await sleep(250)
    }
    console.log(`[arena-combat] respawn=${JSON.stringify(respawn)} spawnPoints=${combat ? JSON.stringify(combat.spawnPoints) : 'no-combat-captured'}`)

    let serverKills = null
    check(!!combat, 'no combat behaviour was captured from the server, so no server-side kill/respawn state could be asserted')
    if (combat) {
      const killerStats = combat.statsOf(shooterId)
      const victimStats = combat.statsOf(victimId)
      console.log(`[arena-combat] server stats killer(${shooterId})=${JSON.stringify(killerStats)} victim(${victimId})=${JSON.stringify(victimStats)}`)
      serverKills = killerStats.kills
      check(killerStats.kills >= 1, `server combat stats credited the killer with ${killerStats.kills} kill(s), expected at least 1`)
      check(victimStats.deaths >= 1, `server combat stats recorded ${victimStats.deaths} death(s) for the victim, expected at least 1`)
      check(combat.isRespawning(victimId) === false, `server still lists the victim as respawning after the respawn window`)
    }
    check(!!respawn, `the victim never came back alive at a combat spawn point within ${RESPAWN_TIMEOUT_MS}ms of dying`)
    if (respawn) {
      check(respawn.health >= 100, `the victim respawned with health ${respawn.health}, expected the full 100`)
      check(respawn.spawnIndex >= 0, `the victim respawned at ${JSON.stringify(respawn.position)}, which is more than ${SPAWN_TOLERANCE_M}m from every combat spawn point`)
    }

    for (const c of clients) {
      c.tps = await c.page.evaluate(readTps).catch(() => null)
      console.log(`[arena-combat] ${c.label} tps=${JSON.stringify(c.tps)}`)
    }
    check(roles.shooter.tps && roles.shooter.tps.kills >= 1, `the killer's own client shows ${roles.shooter.tps ? roles.shooter.tps.kills : 'no'} kill(s) credited, expected at least 1`)
    check(roles.shooter.tps && roles.shooter.tps.funKill >= 1, `the killer's own client counted ${roles.shooter.tps ? roles.shooter.tps.funKill : 'no'} kill juice event(s), expected at least 1`)
    check(roles.victim.tps && roles.victim.tps.respawnFadeAt > 0, `the victim's own client never processed a respawn event (respawnFadeAt=${roles.victim.tps ? roles.victim.tps.respawnFadeAt : 'no tps'})`)
    check(roles.victim.tps && roles.victim.tps.ammo === 30, `the victim's own client has ammo ${roles.victim.tps ? roles.victim.tps.ammo : 'unknown'} after respawn, expected the full magazine of 30`)

    for (const c of clients) {
      const alive = await c.page.evaluate('1 + 1').catch(e => 'evaluate-threw: ' + (e?.message || e))
      c.alive = alive === 2
      check(c.alive, `${c.label} did not answer an evaluate after the drive, so this arm's observations are not from a live page (${String(alive)})`)
    }
    console.log(`[arena-combat] liveness shooter=${shooter.alive} victim=${victim.alive} observer=${observer.alive}`)

    await browser.close().catch(() => {})
    browser = null
    server.stop()

    let appEventErrors = 0
    for (const c of clients) {
      const errors = c.consoleEntries.filter(e => e.level === 'error' || e.level === 'exception')
      const appEvents = errors.filter(e => e.text.includes('[app-event]'))
      appEventErrors += appEvents.length
      console.log(`[arena-combat] ${c.label} consoleEntries=${c.consoleEntries.length} consoleErrors=${errors.length} appEventErrors=${appEvents.length} pageErrors=${c.pageErrors.length} failedRequests=${c.failedRequests.length} cancelledRequests=${c.cancelledRequests.length}`)
      for (const e of errors.slice(0, 10)) console.log(`  [${c.label}][${e.level}] ${e.text.slice(0, 1200)}`)
      for (const e of c.pageErrors.slice(0, 10)) console.log(`  [${c.label}][pageerror] ${String(e).slice(0, 240)}`)
      if (c.pageErrors.length) failures.push(`${c.label} had ${c.pageErrors.length} uncaught page error(s): ${String(c.pageErrors[0]).slice(0, 200)}`)
      for (const e of errors.filter(x => !x.text.includes('[app-event]'))) failures.push(`${c.label} had a console error: ${e.text.slice(0, 200)}`)
      for (const e of appEvents) failures.push(`${c.label} threw from an app event handler: ${e.text.slice(0, 300)}`)
    }
    check(appEventErrors === 0, `${appEventErrors} app event handler error(s) were logged across the room`)

    if (failures.length) {
      console.error(`[arena-combat] RESULT: FAIL (${failures.length} check(s))`)
      for (const f of failures) console.error(`  FAIL ${f}`)
      const pending = await exitAfterQuiesce(1)
      console.error(pending ? `teardown left ${pending} referenced handle(s), forcing exit` : 'teardown complete, no referenced handles left')
      return
    }
    console.log(`[arena-combat] RESULT: PASS -- ${EXPECTED_PLAYERS} real clients in one arena-combat room, victim died at ${victimDeadAt}ms and respawned at ${JSON.stringify(respawn && respawn.position)} (spawn point #${respawn && respawn.spawnIndex}) with health ${respawn && respawn.health}, killer credited ${serverKills} kill(s) server-side and ${roles.shooter.tps.kills} on its own client, 0 app event errors`)
    const pending = await exitAfterQuiesce(0)
    console.error(pending ? `teardown left ${pending} referenced handle(s), forcing exit` : 'teardown complete, no referenced handles left')
  } catch (e) {
    console.error('[arena-combat] run FAILED:', e.stack || e.message)
    for (const c of allClients) dumpClient(c)
    failures.push(`run threw: ${e.message || e}`)
    if (browser) await browser.close().catch(() => {})
    server.stop()
    const pending = await exitAfterQuiesce(1)
    console.error(pending ? `teardown left ${pending} referenced handle(s), forcing exit` : 'teardown complete, no referenced handles left')
  }
}

main()
