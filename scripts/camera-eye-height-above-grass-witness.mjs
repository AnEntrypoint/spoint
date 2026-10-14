#!/usr/bin/env node
// CAMERA / EYE HEIGHT ABOVE THE GRASS -- the eye is the last unmeasured ground.
//
// PERF-player-hovering-above-grass-1013 measured every GROUND and found them the same surface to
// under 0.098 m out to 400 m: physics collider, exact CPU solve, rendered mesh and grass placement
// all agree, and the player's feet sit within 0.05 m of a real blade at every rung. The ground is
// therefore NOT the defect. What was never measured is the EYE, because camera Y only exists in a
// page: it is written per frame by client/core/camera.js from the local player's mesh.
//
// This witness boots the real world in a real accelerated browser and, at each of five distances
// from spawn, reports:
//
//   eyeY             window.__camera.position + floatingOrigin.getShift() -- the authoritative eye.
//                    camera.position is FLOATING-ORIGIN LOCAL (FloatingOrigin.update() sets it to
//                    0,0,0 on a rebase), so reading it without the shift is not a height at all.
//   meshBaseY        window.debug.playerMeshes.get(localId).position + shift -- the base of the
//                    player's own mesh, i.e. the rig's pivot. SceneGraph.placeDirect puts it at
//                    state.position[1] - feetOffset, so it is the FEET, not the capsule centre.
//   centreY          client.getLocalState().position[1] -- the authoritative capsule centre.
//   groundAtPlayer   window.__terrain.frame.groundHeightLocal(px, pz) -- the exact CPU solve the
//                    published ground witness already tied the grass blade to (0.0625 m worst).
//   groundAtEye      the same solve under the eye's own (x, z).
//
// and, from them, the two numbers the owner's report is about:
//   eye - meshBase   the eye above the player's feet.
//   eye - ground     the eye above the grass, under the player and under the eye itself.
//
// The owning layer is named by arithmetic, not by looking: the TPS rig sets
//   camTarget.y   = meshBase.y + headHeight                      (camera.js update())
//   camDesired.y  = camTarget.y - sin(pitch)*dist + 0.2          (camera.js updateTPS())
// so with a boom of horizontal length `horiz` the eye above the mesh base must be
// headHeight + 0.2 - tan(pitch)*horiz. Reporting implied headHeight = eye - meshBase + tan(pitch)*horiz
// - 0.2 therefore separates the three candidates:
//   implied headHeight ~ the world's configured headHeight  -> the RIG OFFSET owns it
//   implied headHeight ~ configured + (capsule centre - feet) -> the BOOM pivots on the CENTRE
//   eye - meshBase drifting with distance or with rebaseCount -> FLOATING ORIGIN owns it
//
// It boots a browser, so it rides SPOINT_GPU_WITNESS and scripts/gpulock.mjs and never the
// gpu-free arm of scripts/check.mjs:
//   SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run camera-eye -- \
//     node scripts/camera-eye-height-above-grass-witness.mjs --gpu=amd
import { resolve, dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { ensureStandaloneServer, stopWitnessServers } from './lib/witness-server.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { probeGpu, rasterizerClass } from './lib/gpu-probe.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = join(ROOT, 'data', 'camera-eye-height')
const LABEL = 'camera-eye-height'

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log(`SKIP ${LABEL}-witness: SPOINT_GPU_WITNESS is not 1 (reaches cdp-browser/WebGPURenderer, not run in the gpu-free arm)`)
  process.exit(0)
}

const argv = process.argv.slice(2)
const ARGS = new Map()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq > 0) ARGS.set(a.slice(2, eq), a.slice(eq + 1))
  else ARGS.set(a.slice(2), (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : true)
}
const flag = (n, d) => (ARGS.has(n) ? ARGS.get(n) : d)
const num = (n, d) => { const v = Number(flag(n, String(d))); return Number.isFinite(v) ? v : d }

const GPU = String(flag('gpu', 'amd'))
const WORLD = String(flag('world', 'tps-game'))
// The same five rungs the published ground witness used, so the two are comparable.
const DISTANCES_M = String(flag('distances', '0,50,100,200,400')).split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0)
// The capsule centre rests this far above the ground: the standing offset the published ground
// witness pins (standingCentreY(0) = 1.01 in world tps-game). Used only to give a hop an explicit
// altitude, never as a measured height.
const STAND_OFFSET_M = num('stand-offset', 1.01)
const HOP_M = num('hop-m', 40)
const SETTLE_MS = num('settle', 20000)
const RUNG_SETTLE_MS = num('rung-settle', 4000)
// Two samples this far apart that agree within this are a settled camera, not one still damping.
const STABLE_EPS_M = num('stable-eps', 0.01)
// A pose question does not need a frame-time verdict, but the arm still has to say whether rAF
// left the 16.68 ms grid, because a vsync-locked arm cannot be quoted for millisecond deltas.
const RAF_FRAMES = num('raf-frames', 120)
const VSYNC_GRID_MS = 16.68
const GRID_TOL_MS = num('grid-tol', 0.6)
const PORT = 38000 + Math.floor(Math.random() * 1500)
const VIEW_W = num('w', DEFAULT_VIEWPORT.width)
const VIEW_H = num('h', DEFAULT_VIEWPORT.height)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (s) => console.log(`[${LABEL}] ${s}`)

const PROBE = `(() => {
  const fin = (v) => (Number.isFinite(v) ? v : null)
  const d = window.debug || {}
  const cam3 = window.__camera || null
  const fo = window.__floatingOrigin || null
  const client = window.__client || null
  const ls = client && client.getLocalState ? client.getLocalState() : null
  const frame = window.__terrain && window.__terrain.frame ? window.__terrain.frame : null
  const shift = fo && fo.getShift ? fo.getShift() : null
  const camCtl = d.cam || null
  const lid = client ? client.playerId : null
  const pm = d.playerMeshes || null
  const mesh = (pm && lid != null && pm.get) ? pm.get(lid) : null
  const ri = window.__rendererInfo || null
  const out = {
    hasCamera: !!cam3, hasFo: !!fo, hasState: !!ls, hasFrame: !!frame, hasMesh: !!mesh,
    hasSpoint: typeof window.__spoint === 'object' && !!window.__spoint,
    terrainKeys: window.__terrain ? Object.keys(window.__terrain) : null,
    frameFns: frame ? Object.getOwnPropertyNames(Object.getPrototypeOf(frame)) : null,
    renderer: ri ? { cls: ri.class || null, backend: ri.backend || null } : null,
    mode: camCtl ? camCtl.getMode() : null,
    zoomIndex: camCtl && camCtl.getZoomIndex ? camCtl.getZoomIndex() : null,
    yaw: camCtl ? fin(camCtl.yaw) : null,
    pitch: camCtl ? fin(camCtl.pitch) : null,
    rebaseCount: fo && fo.getRebaseCount ? fo.getRebaseCount() : null,
    onGround: ls ? !!ls.onGround : null,
    teleportHold: ls ? !!ls.teleportHold : null,
    velY: ls && ls.velocity ? fin(ls.velocity[1]) : null,
  }
  const s = shift ? [shift.x, shift.y, shift.z] : null
  out.shift = s
  out.eyeRender = cam3 ? [cam3.position.x, cam3.position.y, cam3.position.z] : null
  out.meshRender = mesh ? [mesh.position.x, mesh.position.y, mesh.position.z] : null
  out.centreAuth = ls && ls.position ? [ls.position[0], ls.position[1], ls.position[2]] : null
  const add = (a) => (a && s ? [a[0] + s[0], a[1] + s[1], a[2] + s[2]] : null)
  out.eyeWorld = add(out.eyeRender)
  out.meshWorld = add(out.meshRender)
  const ground = (p) => {
    if (!frame || !p || typeof frame.groundHeightLocal !== 'function') return null
    try { return fin(frame.groundHeightLocal(p[0], p[2])) } catch (_) { return null }
  }
  out.groundAtPlayer = ground(out.centreAuth)
  out.groundAtEye = ground(out.eyeWorld)
  const e = out.eyeWorld, m = out.meshWorld, c = out.centreAuth
  out.eyeAboveMeshBase = (e && m) ? e[1] - m[1] : null
  out.eyeAboveCentre = (e && c) ? e[1] - c[1] : null
  out.centreAboveGround = (c && Number.isFinite(out.groundAtPlayer)) ? c[1] - out.groundAtPlayer : null
  out.eyeAboveGroundAtPlayer = (e && Number.isFinite(out.groundAtPlayer)) ? e[1] - out.groundAtPlayer : null
  out.eyeAboveGroundAtEye = (e && Number.isFinite(out.groundAtEye)) ? e[1] - out.groundAtEye : null
  let horiz = null
  if (e && m) horiz = Math.hypot(e[0] - m[0], e[2] - m[2])
  out.boomHorizM = fin(horiz)
  // eye = meshBase + headHeight + 0.2 - sin(pitch)*dist, and horiz = dist*cos(pitch), so
  // sin(pitch)*dist = tan(pitch)*horiz.
  out.impliedHeadHeight = (out.eyeAboveMeshBase !== null && horiz !== null && Number.isFinite(out.pitch))
    ? out.eyeAboveMeshBase + Math.tan(out.pitch) * horiz - 0.2
    : null
  return out
})()`

const RAF_PROBE = `(() => new Promise((done) => {
  const t = []
  let last = performance.now()
  let n = 0
  function step(now) {
    t.push(now - last); last = now
    if (++n >= ${RAF_FRAMES}) {
      t.sort((a, b) => a - b)
      const med = t[t.length >> 1]
      const k = Math.round(med / ${VSYNC_GRID_MS})
      done({ n: t.length, medianMs: med, nearestGridMultiple: k, offGridMs: Math.abs(med - k * ${VSYNC_GRID_MS}) })
      return
    }
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}))()`

async function readProbe(page) {
  return page.evaluate(PROBE).catch((e) => ({ error: String((e && e.message) || e) }))
}

async function waitBoot(page) {
  const t0 = Date.now()
  while (Date.now() - t0 < 180000) {
    const st = await page.evaluate(`(() => ({
      terrain: !!(window.__terrain && window.__terrain.frame),
      state: !!(window.__client && window.__client.getLocalState && window.__client.getLocalState()),
      cam: !!window.__camera, debug: !!window.debug,
    }))()`).catch(() => null)
    if (st && st.terrain && st.state && st.cam && st.debug) return { ok: true, ms: Date.now() - t0, st }
    await sleep(1000)
  }
  return { ok: false, ms: Date.now() - t0, st: null }
}

// go({x, z}) refuses with "no terrain height at target and no explicit y" wherever the client's
// own height query has no answer, so every hop carries an explicit y: the altitude the player is
// already resting at. The player then falls onto the collider and the rung is only counted when
// onGround is true again, so an explicit y can never become a measured height of its own.
async function goTo(page, x, z, y, standOffsetM) {
  const res = await page.evaluate(({ x, z, y, standOffsetM }) => {
    if (!window.__spoint || typeof window.__spoint.go !== 'function') return { error: 'window.__spoint.go is absent' }
    // Prefer the ground the client itself solves at the target plus the standing offset the
    // published ground witness pins (the capsule centre rests 1.01 m above its feet), and fall
    // back to an explicit y only when that solve has no answer there.
    let useY = y
    const fr = window.__terrain && window.__terrain.frame
    if (fr && typeof fr.groundHeightLocal === 'function') {
      let g = NaN
      try { g = fr.groundHeightLocal(x, z) } catch (_) {}
      if (Number.isFinite(g)) useY = g + standOffsetM
    }
    const target = (useY === null || !Number.isFinite(useY)) ? { x, z } : { x, y: useY, z }
    window.__goReport = null
    window.__spoint.go(target)
      .then((r) => { window.__goReport = { ms: r && r.ms, frames: r && r.frames, placed: r && r.placed } })
      .catch((e) => { window.__goReport = { error: String((e && e.message) || e) } })
    return { asked: target }
  }, { x, z, y, standOffsetM }).catch((e) => ({ error: String((e && e.message) || e) }))
  if (res && res.error) return res
  const t0 = Date.now()
  while (Date.now() - t0 < 120000) {
    const r = await page.evaluate(`(() => window.__goReport || null)()`).catch(() => null)
    if (r) return r
    await sleep(500)
  }
  return { error: 'window.__spoint.go never reported' }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const lines = []
  const rec = (s) => { lines.push(s); say(s) }

  const served = await ensureStandaloneServer({ port: PORT, label: `${LABEL} node server.js :${PORT}` })
  if (!served.up) throw new Error(`server not up on :${PORT}`)
  rec(`server :${PORT} up=${served.up} owned=${served.owned}`)

  const launchArgs = [...vendorLaunchArgs(GPU), '--disable-frame-rate-limit', '--disable-gpu-vsync', `--window-size=${VIEW_W},${VIEW_H + 90}`]
  rec(`launch args: ${launchArgs.join(' ')}`)
  const browser = await chromium.launch({ owner: `${LABEL}-browser`, args: launchArgs })
  let exitCode = 0
  const report = { label: LABEL, gpu: null, rungs: [], raf: null, failures: [] }
  try {
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
    const url = `http://localhost:${PORT}/?world=${WORLD}&singleplayer&v=${Date.now()}`
    rec(`url ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    const gpu = await probeGpu(page)
    gpu.rasterizer = rasterizerClass(gpu)
    report.gpu = gpu
    rec(`gpu renderer=${gpu.renderer} vendor=${gpu.vendor} rasterizer=${gpu.rasterizer}`)

    const boot = await waitBoot(page)
    rec(`boot ready=${boot.ok} after ${boot.ms}ms`)
    if (!boot.ok) throw new Error('the page never exposed terrain + local state + camera + debug')

    const ri = await page.evaluate(`(() => (window.__rendererInfo ? { cls: window.__rendererInfo.class, backend: window.__rendererInfo.backend } : null))()`)
    rec(`window.__rendererInfo ${JSON.stringify(ri)}`)
    // Both WebGL fallbacks are refused: TSL is the only shader path, and a WebGL answer would be a
    // different renderer answering a question about the shipped one.
    if (!ri || ri.cls !== 'WebGPURenderer' || ri.backend !== 'webgpu') {
      throw new Error(`renderer is ${JSON.stringify(ri)}, not WebGPURenderer/webgpu -- this arm cannot attribute a pose to the shipped path`)
    }

    await sleep(SETTLE_MS)
    const raf = await page.evaluate(RAF_PROBE).catch((e) => ({ error: String((e && e.message) || e) }))
    report.raf = raf
    if (raf && Number.isFinite(raf.medianMs)) {
      const onGrid = raf.offGridMs <= GRID_TOL_MS
      rec(`rAF median ${raf.medianMs.toFixed(2)} ms over ${raf.n} frame(s), nearest ${raf.nearestGridMultiple}x${VSYNC_GRID_MS} off by ${raf.offGridMs.toFixed(2)} ms -> ${onGrid ? 'VSYNC-LOCKED' : 'UNLOCKED'}`)
      // A pose is not a frame-time claim, so a locked rAF is reported and not failed: it only
      // means no millisecond delta may be quoted from this run.
    } else rec(`rAF probe did not run: ${JSON.stringify(raf)}`)

    const first = await readProbe(page)
    rec(`spawn ${JSON.stringify(first)}`)
    if (!first.eyeWorld || !first.centreAuth) throw new Error('no eye or local player state at spawn')
    const x0 = first.centreAuth[0], z0 = first.centreAuth[2]
    rec(`spawn centre ${x0.toFixed(2)},${z0.toFixed(2)} mode=${first.mode} zoomIndex=${first.zoomIndex} pitch=${first.pitch} yaw=${first.yaw}`)

    let cur = 0
    let lastCentreY = first.centreAuth ? first.centreAuth[1] : null
    for (const d of DISTANCES_M) {
      // Walk out in hops so the heightfield streamer keeps a centre to build around, exactly as
      // the published ground witness does.
      let hops = 0
      while (cur !== d && hops < 64) {
        const stepTo = cur + Math.sign(d - cur) * Math.min(HOP_M, Math.abs(d - cur))
        const r = await goTo(page, x0 + stepTo, z0, lastCentreY === null ? null : lastCentreY + 2, STAND_OFFSET_M)
        if (r && r.error) { rec(`  hop to ${stepTo} m refused: ${r.error}`); break }
        cur = stepTo
        hops++
        await sleep(1200)
        const p = await readProbe(page)
        if (p && p.centreAuth) lastCentreY = p.centreAuth[1]
      }
      await sleep(RUNG_SETTLE_MS)
      // An explicit-y hop can leave the player mid-fall, so wait for onGround before the rung is
      // read: a falling player's eye is a damped follow, not the rig's rest pose.
      const tg = Date.now()
      let grounded = false
      while (Date.now() - tg < 30000) {
        const p = await readProbe(page)
        if (p && p.onGround) { grounded = true; break }
        await sleep(1000)
      }
      let a = await readProbe(page)
      await sleep(1500)
      let b = await readProbe(page)
      if (a && b && Number.isFinite(a.eyeAboveMeshBase) && Number.isFinite(b.eyeAboveMeshBase)
          && Math.abs(a.eyeAboveMeshBase - b.eyeAboveMeshBase) > STABLE_EPS_M) {
        await sleep(RUNG_SETTLE_MS)
        a = b; b = await readProbe(page)
      }
      const rung = {
        distanceM: d, grounded,
        reachedCentre: b && b.centreAuth ? [+b.centreAuth[0].toFixed(3), +b.centreAuth[2].toFixed(3)] : null,
        actualDistanceM: (b && b.centreAuth) ? +Math.hypot(b.centreAuth[0] - x0, b.centreAuth[2] - z0).toFixed(2) : null,
        onGround: b ? b.onGround : null,
        rebaseCount: b ? b.rebaseCount : null,
        eyeY: b && b.eyeWorld ? +b.eyeWorld[1].toFixed(4) : null,
        meshBaseY: b && b.meshWorld ? +b.meshWorld[1].toFixed(4) : null,
        centreY: b && b.centreAuth ? +b.centreAuth[1].toFixed(4) : null,
        groundAtPlayer: Number.isFinite(b && b.groundAtPlayer) ? +b.groundAtPlayer.toFixed(4) : null,
        groundAtEye: Number.isFinite(b && b.groundAtEye) ? +b.groundAtEye.toFixed(4) : null,
        eyeAboveFeet: Number.isFinite(b && b.eyeAboveMeshBase) ? +b.eyeAboveMeshBase.toFixed(4) : null,
        eyeAboveCentre: Number.isFinite(b && b.eyeAboveCentre) ? +b.eyeAboveCentre.toFixed(4) : null,
        centreAboveGround: Number.isFinite(b && b.centreAboveGround) ? +b.centreAboveGround.toFixed(4) : null,
        eyeAboveGrassAtPlayer: Number.isFinite(b && b.eyeAboveGroundAtPlayer) ? +b.eyeAboveGroundAtPlayer.toFixed(4) : null,
        eyeAboveGrassAtEye: Number.isFinite(b && b.eyeAboveGroundAtEye) ? +b.eyeAboveGroundAtEye.toFixed(4) : null,
        boomHorizM: Number.isFinite(b && b.boomHorizM) ? +b.boomHorizM.toFixed(3) : null,
        pitch: b ? b.pitch : null,
        impliedHeadHeight: Number.isFinite(b && b.impliedHeadHeight) ? +b.impliedHeadHeight.toFixed(4) : null,
      }
      if (!grounded) {
        // A player that never settles is not at the rung, so the ladder stops rather than
        // measuring the same hole five times and calling it five rungs.
        rec(`rung ${d} m was never reached (onGround false after ${RUNG_SETTLE_MS} ms + 30 s) -- ladder stopped`)
        break
      }
      report.rungs.push(rung)
      rec(`rung ${JSON.stringify(rung)}`)
    }

    // A rung only counts where the player is actually standing: a falling or ungrounded player
    // carries a damped follow eye, which is not the rig's rest pose and must not be quoted.
    const ok = report.rungs.filter((r) => r.grounded && Number.isFinite(r.eyeAboveFeet) && Number.isFinite(r.eyeAboveGrassAtEye))
    if (ok.length === 0) {
      report.failures.push(`no rung was measured (${report.rungs.length} rung(s) attempted) -- the eye was never read where the player stands`)
    }
    const feet = ok.map((r) => r.eyeAboveFeet)
    const grass = ok.map((r) => r.eyeAboveGrassAtEye)
    const heads = ok.map((r) => r.impliedHeadHeight).filter((v) => Number.isFinite(v))
    const spread = (a) => (a.length ? +(Math.max(...a) - Math.min(...a)).toFixed(4) : null)
    report.summary = {
      rungs: report.rungs.length, measured: ok.length,
      eyeAboveFeetMin: feet.length ? +Math.min(...feet).toFixed(4) : null,
      eyeAboveFeetMax: feet.length ? +Math.max(...feet).toFixed(4) : null,
      eyeAboveFeetSpread: spread(feet),
      eyeAboveGrassMin: grass.length ? +Math.min(...grass).toFixed(4) : null,
      eyeAboveGrassMax: grass.length ? +Math.max(...grass).toFixed(4) : null,
      eyeAboveGrassSpread: spread(grass),
      impliedHeadHeightMin: heads.length ? +Math.min(...heads).toFixed(4) : null,
      impliedHeadHeightMax: heads.length ? +Math.max(...heads).toFixed(4) : null,
      impliedHeadHeightSpread: spread(heads),
      rebases: Math.max(...report.rungs.map((r) => r.rebaseCount || 0)),
    }
    rec(`summary ${JSON.stringify(report.summary)}`)

    // A pose that drifts with distance is a field/streamer bug; a pose that is flat is a constant
    // rig offset. Either way the spread has to be small enough to name one owning layer.
    if (report.summary.eyeAboveFeetSpread !== null && report.summary.eyeAboveFeetSpread > 0.5) {
      report.failures.push(`eye-above-feet spread ${report.summary.eyeAboveFeetSpread} m over ${ok.length} rung(s) is not flat, so this is not a constant rig offset`)
    }
    if (report.summary.impliedHeadHeightSpread !== null && report.summary.impliedHeadHeightSpread > 0.1) {
      report.failures.push(`implied headHeight spread ${report.summary.impliedHeadHeightSpread} m over ${heads.length} rung(s): the rig identity does not hold at every rung, so no single layer owns the eye`)
    }
    if (!heads.length) report.failures.push('implied headHeight was never computable -- the rig identity was never tested')

    report.exitCode = report.failures.length ? 1 : 0
    exitCode = report.exitCode
    if (report.failures.length) for (const f of report.failures) rec(`FAIL ${f}`)
    const s = report.summary
    rec(`RESULT: ${report.failures.length ? 'FAIL' : 'PASS'} label=${LABEL} -- eye-above-feet ${s.eyeAboveFeetMin} .. ${s.eyeAboveFeetMax} m, eye-above-grass ${s.eyeAboveGrassMin} .. ${s.eyeAboveGrassMax} m, worst spread ${s.eyeAboveFeetSpread} m, implied headHeight ${s.impliedHeadHeightMin} .. ${s.impliedHeadHeightMax} m over ${s.measured} rung(s), rebase(s) ${s.rebases}`)
  } catch (e) {
    report.failures.push(String((e && e.message) || e))
    console.log((e && e.stack) || String(e))
    rec(`RESULT: FAIL label=${LABEL} -- ${String((e && e.message) || e)}`)
    exitCode = 1
  } finally {
    await browser.close().catch(() => {})
    await stopWitnessServers().catch(() => {})
    writeFileSync(join(OUT_DIR, 'camera-eye-height.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(OUT_DIR, 'camera-eye-height.txt'), lines.join('\n') + '\n')
    process.exit(exitCode)
  }
}

main().catch((e) => {
  console.log((e && e.stack) || String(e))
  console.log(`RESULT: FAIL label=${LABEL} -- ${String((e && e.message) || e)}`)
  process.exit(1)
})
