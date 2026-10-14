#!/usr/bin/env node
// one-fps-pathology-witness.mjs -- PERF-one-fps-pathology-1013.
//
// Owner report, verbatim: "we're still seeing super low framerates in the browser tests like 1fps".
// The measured frame in the fill-bound regime is 50.55-59.16 ms wall (17-20 fps), so 1 fps is
// 17-20x worse and is a PATHOLOGY, not the frame cost under optimisation.
//
// This witness answers it with COUNTED WORK UNITS at the WebGPU API boundary, because counts
// survive the ~18-lane contention on this box and millisecond deltas do not. It patches
// GPUDevice.prototype.{createRenderPipeline,createRenderPipelineAsync,createShaderModule,
// createComputePipeline,createComputePipelineAsync} in an init script, attributes every call to a
// frame, and reports compiles/frame for a settled frame, for a walk, and for a stream batch.
//
// It runs the A/B the owner's follow-up asks for -- the same page and the same edit traffic with
// the dev HMR watcher ON and OFF -- because the owner's own prime suspect moved to HMR:
//
//   SPOINT_HMR unset  -> src/sdk/DevHmr.js isDevHmrEnabled() true, /dev/HmrRuntime.js is injected
//                        into the served html and every edit under client,src,apps,packages,types
//                        is classified and pushed to the page as an event.
//   SPOINT_HMR=0      -> no watcher, no runtime script, no events.
//
// Contention is not assumed away: both arms run back to back on the same box, so whatever the
// other lanes are doing is a shared condition, and the difference between the arms is the thing
// measured.
//
// Run it as:
//   node scripts/gpulock.mjs run <owner> -- node scripts/one-fps-pathology-witness.mjs
//
// Registered in scripts/check.mjs behind SPOINT_GPU_WITNESS, never in the gpu-free arm: it boots a
// real browser on the accelerated adapter.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'

const LABEL = 'one-fps-pathology'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : dflt
}

const ARM = arg('arm', 'both') // hmr-on | hmr-off | both
const WORLD = arg('world', 'tps-game')
const GPU_MODE = arg('gpu', 'nvidia')
const SETTLE_MS = Number(arg('settle', '8000'))
const WALK_MS = Number(arg('walk', '8000'))
const STORM_MS = Number(arg('storm', '12000'))
const EDIT_EVERY_MS = Number(arg('edit-every', '1500'))
const READY_TIMEOUT_MS = Number(arg('ready-timeout', '180000'))
const LEASE_WAIT_MS = Number(arg('lease-wait', '600000'))
const LEASE_TTL_MS = Number(arg('lease-ttl', '20')) * 60 * 1000
const OUT_DIR = resolve(arg('out', join(ROOT, 'data', 'one-fps-pathology')))
// Default is the RELOAD class: client/dev/HmrRuntime.js calls location.reload() for an edit a
// module graph cannot hot-swap, so one edit is a whole page load -- the strongest form of the
// owner's HMR hypothesis. --storm-file=client/hud/Chat.js A/Bs the accepted (in-page) class.
const STORM_FILE = arg('storm-file', 'client/core/SceneSetup.js')
// A settled frame must compile nothing. The boot window is the positive control: it compiles
// dozens, so a counter that reads 0 everywhere is an instrument gap, not a measurement.
const MIN_BOOT_COMPILES = Number(arg('min-boot-compiles', '20'))

const waitMs = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

// --- the instrument ---------------------------------------------------------------------------
// Installed as a document-start script, so the boot window itself is counted. Statements, not an
// IIFE expression: Page.addScriptToEvaluateOnNewDocument compiles `source` as a script.
const INIT = `
{
  const W = window
  if (W.__onefps) { /* reinstalled on a reload: fall through and re-seed */ }
  const navKey = '__onefps_pageLoads'
  const loads = Number(sessionStorage.getItem(navKey) || 0) + 1
  try { sessionStorage.setItem(navKey, String(loads)) } catch (e) {}
  // A reload-class HMR edit calls location.reload(), which would otherwise reset the counters
  // mid-window; the totals persist through pagehide so a window full of reloads reads as the
  // zero-fps stretch it is instead of as a fresh, healthy page.
  const frameBase = Number(sessionStorage.getItem('__onefps_frames') || 0)
  const compileBase = Number(sessionStorage.getItem('__onefps_compiles') || 0)
  const playBase = Number(sessionStorage.getItem('__onefps_playFrames') || 0)
  const s = {
    installed: true,
    gpuProtoPatched: false,
    pageLoads: loads,
    frames: 0,
    frameBase: frameBase,
    // A rAF tick of the loading screen is not a frame of the game. A reload-class HMR edit parks the
    // page in the loading screen, and that screen ticks at 60fps, so rAF ticks alone would report a
    // healthy frame rate for a window in which the game is not running at all. playFrames counts
    // only ticks where the client has actually revealed the world.
    playFrames: 0,
    playBase: playBase,
    compiles: 0,
    compileBase: compileBase,
    byKind: {},
    perFrame: [],
    recoveryFires: 0,
    uncapturedErrorMatches: 0,
    lastTotal: 0,
  }
  W.__onefps = s
  const tick = () => {
    s.frames++
    try { if (W.__app && W.__app.revealedAt != null) s.playFrames++ } catch (e) {}
    const d = s.compiles - s.lastTotal
    s.lastTotal = s.compiles
    if (s.perFrame.length < 40000) s.perFrame.push(d)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  const persist = () => {
    try {
      sessionStorage.setItem('__onefps_frames', String(frameBase + s.frames))
      sessionStorage.setItem('__onefps_compiles', String(compileBase + s.compiles))
      sessionStorage.setItem('__onefps_playFrames', String(playBase + s.playFrames))
    } catch (e) {}
  }
  addEventListener('pagehide', persist)
  addEventListener('beforeunload', persist)
  setInterval(persist, 500)
  const priorWarn = typeof console.warn === 'function' ? console.warn.bind(console) : null
  console.warn = function () {
    try {
      const t = Array.prototype.map.call(arguments, (a) => (a && a.message) || String(a)).join(' ')
      if (/stuck WebGPU pipeline failure detected/.test(t)) s.recoveryFires++
    } catch (e) {}
    if (priorWarn) priorWarn.apply(console, arguments)
  }
  const bump = (kind) => { s.compiles++; s.byKind[kind] = (s.byKind[kind] || 0) + 1 }
  const patch = (proto, name, kind) => {
    if (!proto) return false
    const d = Object.getOwnPropertyDescriptor(proto, name)
    if (!d || typeof d.value !== 'function' || d.value.__onefpsPatched === true) return false
    const wrapped = function () { bump(kind); return d.value.apply(this, arguments) }
    wrapped.__onefpsPatched = true
    Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true, enumerable: d.enumerable })
    return true
  }
  if (typeof GPUDevice !== 'undefined') {
    const p = GPUDevice.prototype
    let ok = 0
    if (patch(p, 'createRenderPipeline', 'createRenderPipeline')) ok++
    if (patch(p, 'createRenderPipelineAsync', 'createRenderPipelineAsync')) ok++
    if (patch(p, 'createShaderModule', 'createShaderModule')) ok++
    if (patch(p, 'createComputePipeline', 'createComputePipeline')) ok++
    if (patch(p, 'createComputePipelineAsync', 'createComputePipelineAsync')) ok++
    s.gpuProtoPatched = ok > 0
    s.patchedKinds = ok
  }
}
`

const POS_EXPR = `(() => {
  const a = window.__app || {}
  const c = a.client || window.__client
  const p = c && typeof c.getLocalState === 'function' ? c.getLocalState() : null
  return p && p.position ? [p.position.x, p.position.y, p.position.z] : null
})()`

const KEY_EXPR = ({ code, down }) => {
  const fire = (target) => target.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true }))
  fire(window)
  fire(document)
  return true
}

const SNAP_EXPR = `(() => {
  const s = window.__onefps
  if (!s) return null
  const pf = s.perFrame
  let max = 0, sum = 0
  for (let i = 0; i < pf.length; i++) { if (pf[i] > max) max = pf[i]; sum += pf[i] }
  const out = {
    installed: s.installed === true,
    gpuProtoPatched: s.gpuProtoPatched === true,
    patchedKinds: s.patchedKinds || 0,
    pageLoads: s.pageLoads,
    frames: s.frames,
    framesTotal: s.frameBase + s.frames,
    playFrames: s.playFrames,
    playFramesTotal: s.playBase + s.playFrames,
    compiles: s.compiles,
    compilesTotal: s.compileBase + s.compiles,
    byKind: s.byKind,
    recoveryFires: s.recoveryFires,
    windowFrames: pf.length,
    windowCompiles: sum,
    windowMaxPerFrame: max,
    hmrLog: (window.__spointHmr && Array.isArray(window.__spointHmr.log)) ? window.__spointHmr.log.length : null,
    asyncPipelines: window.__asyncRenderPipelines ? JSON.parse(JSON.stringify(window.__asyncRenderPipelines)) : null,
  }
  s.perFrame = []
  return out
})()`

const FLAGS_EXPR = `(() => ({
  hasApp: !!window.__app,
  hasEngine: !!window.__app?.engine,
  hasClient: !!window.__app?.client,
  ready: !!window.__app?.loadingMachine?.isReady,
  revealed: window.__app?.revealedAt != null,
  hmr: !!window.__spointHmr,
  renderer: window.__rendererInfo ? { class: window.__rendererInfo.class, backend: window.__rendererInfo.backend, glRenderer: window.__rendererInfo.glRenderer || window.__rendererInfo.renderer || null } : null,
  instrument: window.__onefps ? { installed: window.__onefps.installed === true, patched: window.__onefps.gpuProtoPatched === true } : null,
}))()`

async function waitReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await page.evaluate(FLAGS_EXPR).catch(() => null)
    if (last && last.ready && last.revealed) return last
    await waitMs(500)
  }
  return last
}

// A snap can land while a reload-class HMR edit is mid-navigation; retry rather than lose the window.
async function snap(page, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const v = await page.evaluate(SNAP_EXPR).catch(() => null)
    if (v) return v
    await waitMs(500)
  }
  return null
}

async function measure(page, ms, label) {
  const a = await snap(page)
  const t0 = Date.now()
  await waitMs(ms)
  const b = await snap(page)
  const wall = Date.now() - t0
  if (!a || !b) return { label, ms, wall, measured: false }
  const frames = b.framesTotal - a.framesTotal
  const compiles = b.compilesTotal - a.compilesTotal
  const playFrames = b.playFramesTotal - a.playFramesTotal
  return {
    label,
    ms,
    wall,
    measured: true,
    frames,
    playFrames,
    playFps: wall > 0 ? +((playFrames * 1000) / wall).toFixed(2) : 0,
    compiles,
    fps: wall > 0 ? +((frames * 1000) / wall).toFixed(2) : 0,
    compilesPerFrame: frames > 0 ? +(compiles / frames).toFixed(3) : null,
    maxCompilesInOneFrame: b.windowMaxPerFrame,
    pageLoads: b.pageLoads - a.pageLoads,
    hmrLogDelta: (a.hmrLog == null || b.hmrLog == null) ? null : b.hmrLog - a.hmrLog,
    recoveryFires: b.recoveryFires - a.recoveryFires,
    recoveryFiresTotal: b.recoveryFires,
    asyncPipelines: b.asyncPipelines,
    byKind: b.byKind,
  }
}

async function runArm(arm) {
  const hmrOn = arm === 'hmr-on'
  const owner = LABEL + '-' + arm
  delete process.env.SPOINT_NO_WATCH
  if (hmrOn) delete process.env.SPOINT_HMR
  else process.env.SPOINT_HMR = '0'
  process.env.SPOINT_DEV = '1'
  process.env.WORLD = process.env.WORLD || WORLD
  const port = Number(arg('port', '')) || (await freePort())
  process.env.PORT = String(port)

  const out = { arm, port, world: process.env.WORLD, hmrOn }
  let server = null
  let browser = null
  try {
    const { boot } = await import('../src/sdk/server.js')
    server = await boot()
    const html = await fetch('http://127.0.0.1:' + port + '/').then((r) => r.text()).catch(() => '')
    out.runtimeInjected = html.includes('/dev/HmrRuntime.js')
    console.log(`[${LABEL}] arm=${arm} server up on ${port}; /dev/HmrRuntime.js injected=${out.runtimeInjected}`)
    if (out.runtimeInjected !== hmrOn) {
      console.error(`[${LABEL}] RESULT: FAIL arm=${arm} -- the HMR runtime injection (${out.runtimeInjected}) does not match the arm (${hmrOn}), so this arm measured the wrong condition`)
      process.exit(1)
    }

    const launchArgs = vendorLaunchArgs(GPU_MODE)
    browser = await chromium.launch({ root: ROOT, owner, leaseWaitMs: LEASE_WAIT_MS, leaseTtlMs: LEASE_TTL_MS, args: launchArgs })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    const seen = []
    page.on('Runtime.consoleAPICalled', (p) => {
      const text = (p?.args || []).map((a) => a?.description || (a?.value === undefined ? '' : String(a.value))).join(' ')
      if (/\[hmr\]|\[renderer\]|stuck WebGPU/.test(text)) { seen.push(text.slice(0, 200)); console.log('  [page] ' + text.slice(0, 200)) }
    })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INIT })

    const url = 'http://127.0.0.1:' + port + '/?singleplayer&world=' + process.env.WORLD
    console.log(`[${LABEL}] arm=${arm} navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    const flags = await waitReady(page, READY_TIMEOUT_MS)
    out.flags = flags
    if (!flags || !flags.ready || !flags.revealed) {
      console.error(`[${LABEL}] RESULT: FAIL arm=${arm} -- the page never became ready and revealed within ${READY_TIMEOUT_MS}ms: ${JSON.stringify(flags)}`)
      process.exit(1)
    }
    out.renderer = flags.renderer
    console.log(`[${LABEL}] arm=${arm} renderer=${JSON.stringify(flags.renderer)} hmrRuntime=${flags.hmr} instrument=${JSON.stringify(flags.instrument)}`)
    if (!flags.renderer || flags.renderer.class !== 'WebGPURenderer' || flags.renderer.backend !== 'webgpu') {
      console.error(`[${LABEL}] RESULT: FAIL arm=${arm} -- window.__rendererInfo is ${JSON.stringify(flags.renderer)}; both WebGL fallbacks are refused, so this arm measured the wrong backend`)
      process.exit(1)
    }
    if (!flags.instrument || flags.instrument.installed !== true || flags.instrument.patched !== true) {
      console.error(`[${LABEL}] RESULT: FAIL arm=${arm} -- the instrument is not installed (${JSON.stringify(flags.instrument)}); an absent counter reads as a measured zero`)
      process.exit(1)
    }
    if (flags.hmr !== hmrOn) {
      console.error(`[${LABEL}] RESULT: FAIL arm=${arm} -- window.__spointHmr=${flags.hmr} does not match the arm (${hmrOn})`)
      process.exit(1)
    }

    // (a) boot window: the positive control. It has to have compiled, or the counter is blind.
    const bootSnap = await page.evaluate(SNAP_EXPR)
    out.bootCompiles = bootSnap ? bootSnap.compilesTotal : null
    out.bootByKind = bootSnap ? bootSnap.byKind : null
    console.log(`[${LABEL}] arm=${arm} BOOT compiles=${out.bootCompiles} byKind=${JSON.stringify(out.bootByKind)}`)
    if (!(out.bootCompiles >= MIN_BOOT_COMPILES)) {
      console.error(`[${LABEL}] RESULT: FAIL arm=${arm} -- boot compiled ${out.bootCompiles} pipeline/shaderModule unit(s), under the ${MIN_BOOT_COMPILES} floor; the counter never moved, so a settled 0 is an instrument gap`)
      process.exit(1)
    }

    // (b) settled: a healthy settled frame compiles nothing.
    out.settled = await measure(page, SETTLE_MS, 'settled')
    console.log(`[${LABEL}] arm=${arm} SETTLED ${JSON.stringify(out.settled)}`)

    // (c) walk: does the stream spike repeat every frame? A walk that never moved the player is a
    // second settled window wearing the wrong label, so the displacement is part of the receipt.
    const p0 = await page.evaluate(POS_EXPR).catch(() => null)
    // CDP Input.dispatchKeyEvent reached no listener; the client reads keydown off window/document,
    // so dispatch it in the page the way scripts/veg-lod-browser-witness.mjs does.
    await page.evaluate(KEY_EXPR, { code: 'KeyW', down: true }).catch(() => null)
    out.walk = await measure(page, WALK_MS, 'walk')
    await page.evaluate(KEY_EXPR, { code: 'KeyW', down: false }).catch(() => null)
    const p1 = await page.evaluate(POS_EXPR).catch(() => null)
    out.walkStart = p0
    out.walkEnd = p1
    out.walkMovedM = (p0 && p1) ? +Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2) : null
    console.log(`[${LABEL}] arm=${arm} WALK movedM=${out.walkMovedM} ${JSON.stringify(out.walk)}`)

    // (d) stream batch / edit storm: measured WHILE the edits land, so the window is the storm.
    const abs = join(ROOT, STORM_FILE)
    const original = readFileSync(abs, 'utf8')
    const stormMeasure = measure(page, STORM_MS, 'storm')
    const t0 = Date.now()
    let edits = 0
    let failed = false
    try {
      while (Date.now() - t0 < STORM_MS) {
        writeFileSync(abs, original + (original.endsWith('\n') ? '' : '\n') + '// one-fps probe ' + Date.now() + '\n')
        edits++
        await waitMs(EDIT_EVERY_MS)
      }
    } catch (e) {
      failed = true
      console.log(`[${LABEL}] arm=${arm} storm write failed: ${e?.message || e}`)
    } finally {
      try { writeFileSync(abs, original) } catch (e) { console.log(`[${LABEL}] arm=${arm} restore failed: ${e?.message || e}`) }
    }
    out.storm = await stormMeasure
    out.stormEdits = edits
    out.stormWriteFailed = failed
    console.log(`[${LABEL}] arm=${arm} STORM edits=${edits} ${JSON.stringify(out.storm)}`)

    out.consoleSeen = seen.length
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (server) { try { server.stop() } catch (_) {} }
  }
  return out
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  if (ARM !== 'both') {
    const out = await runArm(ARM)
    writeFileSync(join(OUT_DIR, ARM + '.json'), JSON.stringify(out, null, 2))
    console.log(`[${LABEL}] MEASURED ${JSON.stringify(out)}`)
    console.log(`RESULT: PASS arm=${ARM} label=${LABEL}`)
    process.exit(0)
  }
  const on = await runArm('hmr-on')
  writeFileSync(join(OUT_DIR, 'hmr-on.json'), JSON.stringify(on, null, 2))
  const off = await runArm('hmr-off')
  writeFileSync(join(OUT_DIR, 'hmr-off.json'), JSON.stringify(off, null, 2))

  const row = (name, a, b) => `${name}: hmr-on=${a} hmr-off=${b}`
  console.log(`[${LABEL}] A/B ${row('settled fps', on.settled?.fps, off.settled?.fps)}`)
  console.log(`[${LABEL}] A/B ${row('walk fps', on.walk?.fps, off.walk?.fps)}`)
  console.log(`[${LABEL}] A/B ${row('storm fps', on.storm?.fps, off.storm?.fps)}`)
  console.log(`[${LABEL}] A/B ${row('storm PLAYABLE fps', on.storm?.playFps, off.storm?.playFps)}`)
  console.log(`[${LABEL}] A/B ${row('settled PLAYABLE fps', on.settled?.playFps, off.settled?.playFps)}`)
  console.log(`[${LABEL}] A/B ${row('page loads during storm', on.storm?.pageLoads, off.storm?.pageLoads)}`)
  console.log(`[${LABEL}] A/B ${row('storm compiles/frame', on.storm?.compilesPerFrame, off.storm?.compilesPerFrame)}`)
  console.log(`[${LABEL}] A/B ${row('settled compiles/frame', on.settled?.compilesPerFrame, off.settled?.compilesPerFrame)}`)
  console.log(`[${LABEL}] A/B ${row('walk compiles/frame', on.walk?.compilesPerFrame, off.walk?.compilesPerFrame)}`)
  console.log(`[${LABEL}] A/B ${row('recovery fires (total)', on.walk?.recoveryFiresTotal, off.walk?.recoveryFiresTotal)}`)
  console.log(`[${LABEL}] A/B ${row('page loads during settle+walk', (on.settled?.pageLoads || 0) + (on.walk?.pageLoads || 0), (off.settled?.pageLoads || 0) + (off.walk?.pageLoads || 0))}`)
  console.log(`[${LABEL}] A/B ${row('hmr log entries during settle+walk', (on.settled?.hmrLogDelta || 0) + (on.walk?.hmrLogDelta || 0), (off.settled?.hmrLogDelta || 0) + (off.walk?.hmrLogDelta || 0))}`)
  console.log(`[${LABEL}] MEASURED ${JSON.stringify({ hmrOn: on, hmrOff: off })}`)
  const bothRan = on.settled?.measured && off.settled?.measured && on.walk?.measured && off.walk?.measured
  console.log(`RESULT: ${bothRan ? 'PASS' : 'FAIL'} arm=both label=${LABEL} -- settled/walk measured in both arms`)
  process.exit(bothRan ? 0 : 1)
}

main().catch((e) => {
  console.error(`[${LABEL}] run FAILED: ${e?.stack || e?.message || e}`)
  console.error(`RESULT: FAIL arm=${ARM} label=${LABEL}`)
  process.exit(1)
})
