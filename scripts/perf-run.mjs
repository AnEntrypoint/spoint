#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { chromium } from './lib/cdp-browser.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'data', 'perf-run')

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
const has = (n) => ARGS.has(n)

const LABEL = flag('label', String(Date.now()))
const SECONDS = Number(flag('seconds', '120'))
const WARMUP_SECONDS = Number(flag('warmup', '3'))
const BACKEND = flag('backend', 'webgl')
const GPU = flag('gpu', 'nvidia')
const WALK = !has('no-walk')
const LEG_MS = Number(flag('leg', '10000'))
const INPUT_WAIT_MS = Number(flag('input-wait', '60000'))
const EXTRA_QUERY = flag('extra', '')
const HARD_TIMEOUT_MS = Number(flag('hard-timeout', '600000'))
setTimeout(() => { console.log('[perf-run] HARD TIMEOUT after ' + HARD_TIMEOUT_MS + 'ms -- abandoning run'); process.exit(3) }, HARD_TIMEOUT_MS).unref()
const OUT_FILE = resolve(OUT_DIR, LABEL + '.json')

const GPU_ARGS = {
  nvidia: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  igpu: ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--igpu-select'],
  swiftshader: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
}

const POS_SRC = `(() => {
  const W = window
  const a = W.__app || {}
  const out = []
  const push = (k, v) => { if (v && typeof v[0] === 'number') out.push([k, [v[0], v[1], v[2]]]) }
  const cls = W.__client && W.__client.getLocalState ? W.__client.getLocalState() : null
  if (cls) push('client.getLocalState', cls.position)
  const st = a.client && a.client.state
  if (st && st.players && st.players[0]) push('players[0]', st.players[0].position)
  if (st && st.local && st.local.position) push('state.local', st.local.position)
  if (a.client && a.client.localPlayer) push('client.localPlayer', a.client.localPlayer.position)
  if (a.localPlayer) push('app.localPlayer', a.localPlayer.position)
  if (a.player) push('app.player', a.player.position)
  if (W.__spoint && W.__spoint.player) push('spoint.player', W.__spoint.player.position)
  if (a.cam && a.cam.position) push('cam', [a.cam.position.x, a.cam.position.y, a.cam.position.z])
  return { cands: out }
})()`

const INSTRUMENT = `(() => {
  const W = window
  if (W.__rig) return
  const rig = { frames: [], longtasks: [], errors: [], glWindow: null, navStart: performance.timeOrigin }
  W.__rig = rig
  W.__rigGlCount = 0
  W.__rigGlDraws = 0
  W.__rigGlOn = false
  const DRAWF = new Set(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements', 'multiDrawElementsWEBGL', 'multiDrawArraysWEBGL'])
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) rig.longtasks.push({ start: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1) })
    }).observe({ entryTypes: ['longtask'] })
  } catch (e) {}
  const origErr = console.error
  console.error = function (...a) {
    try {
      const s = a.map((x) => {
        if (x && x.stack) return String(x.stack).split('\\n').slice(0, 4).join(' | ')
        if (x && typeof x === 'object') { try { return JSON.stringify(x).slice(0, 200) } catch (_) { return String(x) } }
        return String(x)
      }).join(' ~ ')
      rig.errors.push(s.slice(0, 900))
      if (typeof a[0] === 'string' && a[0].includes('render-graph') && !rig.graphCtxDone) {
        rig.graphCtxDone = true
        try {
          const found = []
          const walk = (o) => {
            const ms = Array.isArray(o.material) ? o.material : [o.material]
            for (const m of ms) {
              if (m && typeof m.customProgramCacheKey !== 'function') found.push({ obj: o.name || o.type, objCtor: o.constructor && o.constructor.name, matType: m.type, matCtor: m.constructor && m.constructor.name, isMaterial: !!m.isMaterial, k: String(m.customProgramCacheKey) })
            }
            for (const c of o.children) walk(c)
          }
          if (W.__app && W.__app.scene) walk(W.__app.scene)
          rig.errors.push('render-graph-context: ' + JSON.stringify(found.slice(0, 5)))
        } catch (_) {}
      }
    } catch (_) {}
    return origErr.apply(this, a)
  }
  W.addEventListener('error', (e) => rig.errors.push('onerror: ' + (e.message || '')))
  W.addEventListener('unhandledrejection', (e) => rig.errors.push('unhandled: ' + String(e.reason && e.reason.message || e.reason)))
  const origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = origGetContext.call(this, type, attrs)
    if (ctx && (type === 'webgl2' || type === 'webgl') && !ctx.__rigWrapped) {
      ctx.__rigWrapped = true
      const proto = Object.getPrototypeOf(ctx)
      const names = Object.getOwnPropertyNames(proto)
      for (let i = 0; i < names.length; i++) {
        const k = names[i]
        if (k === 'constructor') continue
        const d = Object.getOwnPropertyDescriptor(proto, k)
        if (!d || typeof d.value !== 'function') continue
        const orig = d.value
        Object.defineProperty(ctx, k, {
          value: function () {
            if (W.__rigGlOn) { W.__rigGlCount++; if (DRAWF.has(k)) W.__rigGlDraws++ }
            return orig.apply(this, arguments)
          },
          writable: true, configurable: true,
        })
      }
    }
    return ctx
  }
  let last = -1
  let draws = 0
  function tick(now) {
    const dt = last < 0 ? 0 : now - last
    last = now
    const info = W.__app && W.__app.renderer && W.__app.renderer.info
    if (info) draws = info.render.calls
    if (rig.frames.length < 400000) rig.frames.push([+now.toFixed(2), +dt.toFixed(2), draws, W.__rigGlOn ? W.__rigGlCount : -1, W.__rigGlOn ? W.__rigGlDraws : -1])
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`

const GPU_PROBE_PS1 = resolve(OUT_DIR, 'gpu-probe.ps1')
const GPU_PROBE_SRC = `$e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
$s = 0
foreach ($x in $e) { if ($x.Name -match 'engtype_3D') { $s += [double]$x.UtilizationPercentage } }
$t = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome-headless-shell.exe'" | Where-Object { $_.CommandLine -match 'dev.train' }).Count
$all = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome-headless-shell.exe'").Count
$c = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Write-Output "gpu3d=$s train=$t chrome=$all cpu=$c"`

function sampleGpu() {
  const r = spawnSync('powershell', ['-NoProfile', '-File', GPU_PROBE_PS1], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  const m3d = /gpu3d=([\d.]+)/.exec(out)
  const mtr = /train=(\d+)/.exec(out)
  const mch = /chrome=(\d+)/.exec(out)
  const mcpu = /cpu=(\d+)/.exec(out)
  return { gpu3d: m3d ? Number(m3d[1]) : null, train: mtr ? Number(mtr[1]) : null, chrome: mch ? Number(mch[1]) : null, cpu: mcpu ? Number(mcpu[1]) : null }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function aggregateProfile(profile) {
  const byId = new Map()
  for (const n of profile.nodes) byId.set(n.id, n)
  const self = new Map()
  let total = 0
  const samples = profile.samples || []
  const deltas = profile.timeDeltas || []
  for (let i = 0; i < samples.length; i++) {
    const us = deltas[i] || 0
    total += us
    const n = byId.get(samples[i])
    if (!n) continue
    const cf = n.callFrame || {}
    const key = (cf.functionName || '(anon)') + ' @ ' + shortUrl(cf.url) + ':' + (cf.lineNumber != null ? cf.lineNumber + 1 : '?')
    self.set(key, (self.get(key) || 0) + us)
  }
  const rows = [...self.entries()].map(([k, us]) => ({ key: k, ms: us / 1000, pct: total ? (100 * us) / total : 0 }))
  rows.sort((a, b) => b.ms - a.ms)
  return { totalMs: total / 1000, rows }
}

function shortUrl(u) {
  if (!u) return ''
  const s = String(u)
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(GPU_PROBE_PS1, GPU_PROBE_SRC)
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  if (has('skip-prewarm')) process.env.SPOINT_SKIP_PREWARM = '1'

  const idleBefore = sampleGpu()
  console.log(`[perf-run] idle probe before: gpu3d=${idleBefore.gpu3d} trainChrome=${idleBefore.train}`)

  console.log(`[perf-run] booting real server on ${port} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[perf-run] server up.')

  const args = [...(GPU_ARGS[GPU] || GPU_ARGS.nvidia)]
  if (GPU === 'igpu') args.push('--disable-features=UseGpuPreferenceForGpuProcess')
  let browser
  const gpuSamples = []
  try {
    browser = await chromium.launch({ headless: true, args })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)))
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    const _cdpTimeoutMs = Number(flag('cdp-timeout', '25000'))
    const _rawEval = page.evaluate.bind(page)
    page.evaluate = (...a) => Promise.race([_rawEval(...a), new Promise((_, rej) => setTimeout(() => rej(new Error('cdp evaluate timeout')), _cdpTimeoutMs))])
    const _rawSend = page._send.bind(page)
    page._send = (...a) => Promise.race([_rawSend(...a), new Promise((_, rej) => setTimeout(() => rej(new Error('cdp send timeout ' + a[0])), _cdpTimeoutMs))])
    const _rawDown = page.keyboard.down.bind(page.keyboard)
    page.keyboard.down = (...a) => Promise.race([_rawDown(...a), new Promise((_, rej) => setTimeout(() => rej(new Error('cdp keydown timeout')), _cdpTimeoutMs))])
    const shot = async (name) => {
      try {
        const { data } = await page._send('Page.captureScreenshot', { format: 'png' })
        writeFileSync(resolve(OUT_DIR, name + '.png'), Buffer.from(data, 'base64'))
        console.log('[perf-run] screenshot: ' + name + '.png')
      } catch (e) { console.log('[perf-run] screenshot failed: ' + e.message) }
    }
    const readPos = async () => {
      const r = await page.evaluate(POS_SRC).catch(() => null)
      if (!r || !r.cands.length) return null
      return r.cands[0]
    }

    const query = BACKEND === 'webgpu' ? '?singleplayer&webgpu=1' : '?singleplayer'
    const url = `http://localhost:${port}/${query}&world=tps-game&v=${Date.now()}${EXTRA_QUERY ? '&' + EXTRA_QUERY : ''}`
    console.log(`[perf-run] navigating ${url}`)
    const tNav = Date.now()
    await page._send('Profiler.enable')
    await page._send('Profiler.setSamplingInterval', { interval: 1000 })
    await page._send('Profiler.start')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })

    let readyAt = null
    const readyStart = Date.now()
    while (Date.now() - readyStart < 300000) {
      const r = await page.evaluate(() => {
        const lm = window.__app && window.__app.loadingMachine
        const overlays = [...document.querySelectorAll('div,section')].filter((e) => {
          const s = getComputedStyle(e)
          if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false
          const t = (e.textContent || '')
          return t.length < 400 && /Building world|Starting game|Compiling shaders|Loading|Connecting/i.test(t)
        }).length
        return { isReady: !!(lm && lm.isReady), revealedAt: window.__app && window.__app.revealedAt || 0, overlays }
      }).catch(() => null)
      if (r && r.isReady && readyAt == null) readyAt = Date.now()
      if (r && r.revealedAt) break
      await new Promise((r2) => setTimeout(r2, 200))
    }
    const revealed = await page.evaluate(() => ({
      revealedAt: (window.__app && window.__app.revealedAt) || 0,
      ready: !!(window.__app && window.__app.loadingMachine && window.__app.loadingMachine.isReady),
      terrain: !!window.__terrain,
      veg: window.__veg ? (window.__veg.totalInstances || 0) : 0,
      players: (window.__app && window.__app.client && window.__app.client.state && window.__app.client.state.players.length) || 0,
      refreshHz: window.__vsync ? window.__vsync.refreshHz : null,
      marks: (() => {
        const out = {}
        try {
          for (const e of performance.getEntriesByType('mark')) {
            if (e.name.startsWith('boot:')) out[e.name] = Math.round(e.startTime)
          }
        } catch (_) {}
        return out
      })(),
      longtasks: (window.__rig ? window.__rig.longtasks : []).slice(0, 12),
      rendererInfo: window.__app && window.__app.renderer ? { calls: window.__app.renderer.info.render.calls, tris: window.__app.renderer.info.render.triangles } : null,
    })).catch((e) => ({ error: e.message }))
    console.log('[perf-run] boot marks: ' + JSON.stringify(revealed.marks || null))
    await shot(LABEL + '-reveal')
    console.log('[perf-run] long tasks (>50ms) in first window: ' + JSON.stringify(revealed.longtasks || []))
    const tReady = readyAt ? readyAt - tNav : null
    const tRevealed = revealed.revealedAt ? revealed.revealedAt : null
    console.log(`[perf-run] nav->isReady=${tReady}ms  nav->overlayHidden(perf.now)=${tRevealed}ms  terrain=${revealed.terrain} veg=${revealed.veg} refreshHz=${revealed.refreshHz}`)
    if (revealed.error) console.log('[perf-run] reveal probe error: ' + revealed.error)

    let navToFirstMoveMs = null
    {
      await page._send('Page.bringToFront').catch(() => {})
      await page.evaluate(() => {
        const sp = window.__spoint
        if (!sp || !sp._drive || sp.__rigDriveWrapped) return
        sp.__rigDriveWrapped = true
        const d = sp._drive
        sp._drive = function (input, cam) {
          window.__rigLastInput = { forward: !!input.forward, back: !!input.back, left: !!input.left, right: !!input.right, jump: !!input.jump }
          return d.apply(this, arguments)
        }
      }).catch(() => {})
      const connected = await page.evaluate(() => ({ connected: !!(window.__client && window.__client.connected), playerId: (window.__client && window.__client.playerId) || null, focus: document.hasFocus(), onGround: (window.__client && window.__client.getLocalState && window.__client.getLocalState().onGround) || null })).catch(() => null)
      console.log('[perf-run] pre-flight: ' + JSON.stringify(connected))
      const p0 = await readPos()
      if (!p0) console.log('[perf-run] WARN no player position source found -- input-acceptance will read null')
      else console.log('[perf-run] position source: ' + p0[0])
      const tInput = Date.now()
      const probeLegs = ['KeyW', 'KeyD', 'KeyS', 'KeyA']
      let probeIdx = 0
      let probeDown = null
      let maxD = 0
      let loggedDrive = false
      let sawVelocity = null
      let probeDumpAt = 0
      let probeDumps = 0
      let navToInputSeqMs = null
      const seqOf = () => page.evaluate(() => {
        const s = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
        const i = window.__rigLastInput
        return { seq: s ? s.inputSequence : null, input: i || null }
      }).catch(() => null)
      const seq0 = await seqOf()
      const moved = await (async () => {
        while (Date.now() - tInput < INPUT_WAIT_MS) {
          if (probeDown === null || Date.now() - probeDown > 1800) {
            if (probeDown !== null) await page.keyboard.up(probeLegs[probeIdx % probeLegs.length]).catch(() => {})
            probeIdx++
            await page.keyboard.down(probeLegs[probeIdx % probeLegs.length]).catch(() => {})
            probeDown = Date.now()
          }
          const p = await readPos()
          if (navToInputSeqMs === null) {
            const s = await seqOf()
            if (s && s.seq != null && seq0 && s.seq !== seq0.seq) navToInputSeqMs = Date.now() - tNav
            else if (s && s.input && (s.input.forward || s.input.back || s.input.left || s.input.right) && (!seq0 || !seq0.input)) navToInputSeqMs = Date.now() - tNav
          }
          if (p0 && p) {
            const d = Math.hypot(p[1][0] - p0[1][0], p[1][1] - p0[1][1], p[1][2] - p0[1][2])
            if (d > maxD) maxD = d
            if (d > 0.25) return true
          }
          if (Date.now() - tInput > 1500 && Date.now() - probeDumpAt > 1000 && probeDumps < 10) {
            probeDumpAt = Date.now(); probeDumps++
            const ds = await page.evaluate(() => {
              const a = window.__app || {}
              const s = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
              return {
                machine: a.clientMachine ? String(a.clientMachine.state && (a.clientMachine.state.value || a.clientMachine.state)) : null,
                input: window.__rigLastInput || null,
                vel: s ? s.velocity : null,
                onGround: s ? s.onGround : null,
                seq: s ? s.inputSequence : null,
                veg: window.__veg ? (window.__veg.instanceCount ?? window.__veg.count ?? null) : null,
                pos: s ? s.position : null,
              }
            }).catch((e) => ({ error: e.message }))
            console.log('[perf-run] probe t+' + Math.round(Date.now() - tInput) + 'ms: ' + JSON.stringify(ds))
          }
          if (Date.now() - tInput > 6000 && !sawVelocity) {
            sawVelocity = await page.evaluate(() => {
              const s = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null
              return s ? { velocity: s.velocity, wallPlanes: s.wallPlanes, onGround: s.onGround, inputSequence: s.inputSequence } : null
            }).catch(() => null)
            console.log('[perf-run] localState while probing: ' + JSON.stringify(sawVelocity))
          }
          await new Promise((r) => setTimeout(r, 100))
        }
        return false
      })()
      if (probeDown !== null) await page.keyboard.up(probeLegs[probeIdx % probeLegs.length]).catch(() => {})
      navToFirstMoveMs = moved ? Date.now() - tNav : null
      if (!moved) {
        console.log(`[perf-run] input probe: NO movement, maxDelta=${maxD.toFixed(3)}m over ${Date.now() - tInput}ms`)
        const dump = await page.evaluate(POS_SRC).catch(() => null)
        console.log('[perf-run] position candidates: ' + JSON.stringify(dump && dump.cands))
        const st = await page.evaluate(() => {
          const a = window.__app || {}
          const c = a.client || {}
          return {
            hasFocus: document.hasFocus(),
            hasClient: !!window.__client,
            localStateKeys: (window.__client && window.__client.getLocalState && Object.keys(window.__client.getLocalState() || {})) || null,
            appKeys: Object.keys(a).slice(0, 40),
            clientKeys: Object.keys(c).slice(0, 40),
            stateKeys: Object.keys(c.state || {}).slice(0, 40),
            playersLen: (c.state && c.state.players && c.state.players.length) || 0,
            machineState: a.clientMachine ? String(a.clientMachine.state && (a.clientMachine.state.value || a.clientMachine.state)) : null,
            overlayVisible: !!(a.revealedAt === undefined || a.revealedAt === 0),
          }
        }).catch((e) => ({ error: e.message }))
        console.log('[perf-run] input diag: ' + JSON.stringify(st))
      }
    }
    console.log(`[perf-run] nav->inputAccepted(first real movement)=${navToFirstMoveMs}ms  nav->inputReachedGame=${navToInputSeqMs}ms`)

    const gpuTimer = setInterval(() => gpuSamples.push({ t: Date.now() - tNav, ...sampleGpu() }), 5000)

    if (has('probe')) {
      const p = await page.evaluate(() => ({
        appKeys: Object.keys(window.__app || {}),
        vegKeys: Object.keys(window.__veg || {}),
        spointKeys: Object.keys(window.__spoint || {}),
        player: window.__app && window.__app.client && window.__app.client.state && window.__app.client.state.players[0],
        cam: !!window.__app && !!window.__app.cam,
        shadowCost: window.__shadowCost ? window.__shadowCost.stats() : null,
        shadowPipeline: window.__shadowPipeline ? window.__shadowPipeline.debug() : null,
        perf: window.__perf ? window.__perf.stats() : null,
        rendererKind: (() => { const r = window.__app && window.__app.renderer; if (!r) return null; if (r.isWebGPURenderer) return 'webgpu'; if (r.isWebGLRenderer) return 'webgl'; return r.constructor && r.constructor.name })(),
        glRenderer: (() => {
          const r = window.__app && window.__app.renderer
          if (!r || !r.getContext) return null
          const gl = r.getContext()
          if (!gl || typeof gl.getExtension !== 'function') return gl ? gl.constructor && gl.constructor.name : null
          const d = gl.getExtension('WEBGL_debug_renderer_info')
          return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
        })(),
      }))
      console.log(JSON.stringify(p, null, 2))
    }

    await new Promise((r) => setTimeout(r, WARMUP_SECONDS * 1000))
    if (has('shadow-split')) await page.evaluate(() => { window.__shadowCost && window.__shadowCost.arm(30) }).catch(() => {})
    if (has('caster-census')) {
      const census = await page.evaluate(() => {
        const byKind = {}
        const walk = (o) => {
          if ((o.isMesh || o.isInstancedMesh || o.instanceIndex) && o.castShadow && o.visible) {
            const k = (o.name || o.constructor?.name || o.type || 'mesh').replace(/[0-9]{3,}/g, '#')
            byKind[k] = (byKind[k] || 0) + 1
          }
          for (const c of o.children) walk(c)
        }
        walk(window.__app.scene)
        return byKind
      }).catch((e) => ({ error: e.message }))
      console.log('[perf-run] shadow caster census: ' + JSON.stringify(census))
    }
    await page.evaluate(() => { const r = window.__perf; if (r) r.reset() }).catch(() => {})
    await page.evaluate(() => { const c = window.__shadowCost; if (c) c.reset() }).catch(() => {})

    if (has('material-audit')) {
      const bad = await page.evaluate(() => {
        const out = []
        const seen = new Set()
        const check = (m, where) => {
          if (!m) return
          const list = Array.isArray(m) ? m : [m]
          for (const mm of list) {
            if (!mm) continue
            if (typeof mm.customProgramCacheKey !== 'function') {
              if (seen.has(mm)) continue
              seen.add(mm)
              out.push({ where, type: mm.type, ctor: mm.constructor && mm.constructor.name, isMaterial: !!mm.isMaterial, cacheKey: String(mm.customProgramCacheKey), keys: Object.keys(mm).slice(0, 8) })
            }
          }
        }
        const walk = (o) => {
          check(o.material, (o.name || o.type || 'obj') + '/' + (o.constructor && o.constructor.name))
          for (const c of o.children) walk(c)
        }
        walk(window.__app.scene)
        check(window.__app.scene.overrideMaterial, 'scene.overrideMaterial')
        check(window.__app.scene.background, 'scene.background')
        return out.slice(0, 20)
      }).catch((e) => ({ error: e.message }))
      console.log('[perf-run] material audit (bad cache key): ' + JSON.stringify(bad))
    }

    if (!has('include-startup-profile')) {
      await page._send('Profiler.stop').catch(() => {})
      await page.evaluate(() => {
        const r = window.__rig
        if (!r) return
        r.startupLongtasks = r.longtasks.slice()
        r.longtasks.length = 0
        r.frames.length = 0
      }).catch(() => {})
      await page._send('Profiler.start').catch(() => {})
      await page.evaluate(() => { const p = window.__perf; if (p && p.reset) p.reset() }).catch(() => {})
    }

    const walkStart = Date.now()
    const legs = WALK ? ['KeyW', 'KeyD', 'KeyS', 'KeyA'] : []
    let legIdx = 0
    let glArmed = false
    const track = []
    while (Date.now() - walkStart < SECONDS * 1000) {
      if (WALK) {
        const code = legs[legIdx % legs.length]
        await page.keyboard.down(code).catch(() => {})
        await new Promise((r) => setTimeout(r, Math.min(LEG_MS, SECONDS * 1000)))
        await page.keyboard.up(code).catch(() => {})
        legIdx++
      } else {
        await new Promise((r) => setTimeout(r, 1000))
      }
      const pos = await readPos()
      if (pos) track.push(pos[1])
      const elapsed = Date.now() - walkStart
      if (elapsed >= 3000 && !glArmed) { glArmed = true; await page.evaluate(() => { window.__rigGlOn = true; window.__rigGlCount = 0; window.__rigGlDraws = 0 }).catch(() => {}) }
      if (elapsed >= 13000 && glArmed) { glArmed = false; await page.evaluate(() => { window.__rigGlOn = false }).catch(() => {}) }
    }
    const walkMs = Date.now() - walkStart

    clearInterval(gpuTimer)
    const { profile } = await page._send('Profiler.stop')
    await shot(LABEL + '-after')

    const inPage = await page.evaluate(() => {
      const rig = window.__rig || { frames: [], longtasks: [], errors: [] }
      const perf = window.__perf ? window.__perf.exportSession() : null
      const shadow = window.__shadowCost ? window.__shadowCost.stats() : null
      const veg = window.__veg ? { totalInstances: window.__veg.totalInstances, meshes: (window.__veg.meshes || []).length } : null
      return {
        frames: rig.frames.slice(-30000),
        frameTotal: rig.frames.length,
        longtasks: rig.longtasks,
        startupLongtasks: rig.startupLongtasks || [],
        errors: rig.errors.slice(0, 40),
        perf, shadow, veg,
        refreshHz: window.__vsync ? window.__vsync.refreshHz : null,
        rendererInfo: window.__app && window.__app.renderer ? { calls: window.__app.renderer.info.render.calls, tris: window.__app.renderer.info.render.triangles, programs: window.__app.renderer.info.programs ? window.__app.renderer.info.programs.length : null } : null,
        shadowPipeline: window.__shadowPipeline ? window.__shadowPipeline.debug() : null,
        vegProfile: window.__vegProfile || null,
        graphStats: (() => {
          const g = window.__renderGraph
          if (!g || !g.nodes) return null
          const out = {}
          for (const n of g.nodes) { const s = n._stats; if (s) out[n.id] = { runs: s.runs, errors: s.errors, skips: s.skips, ms: +s.ema.toFixed(2), calls: s.calls } }
          return out
        })(),
        marks: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('boot:')).map((m) => ({ name: m.name, at: +m.startTime.toFixed(1) })),
        measures: performance.getEntriesByType('measure').map((m) => ({ name: m.name, at: +m.startTime.toFixed(1), dur: +m.duration.toFixed(1) })),
      }
    })

    const deltas = inPage.frames.filter((f) => f[1] > 0).map((f) => f[1]).sort((a, b) => a - b)
    const draws = inPage.frames.filter((f) => f[2] > 0).map((f) => f[2])
    const glFrames = inPage.frames.filter((f) => f[3] >= 0 && f[4] >= 0)
    const glPerFrame = []
    const glDrawPerFrame = []
    for (let i = 1; i < glFrames.length; i++) {
      const d = glFrames[i][3] - glFrames[i - 1][3]
      const g = glFrames[i][4] - glFrames[i - 1][4]
      if (d > 0) glPerFrame.push(d)
      if (g >= 0) glDrawPerFrame.push(g)
    }
    glPerFrame.sort((a, b) => a - b)
    glDrawPerFrame.sort((a, b) => a - b)

    const allLong = (inPage.startupLongtasks || []).concat(inPage.longtasks || [])
    const lt60 = allLong.filter((t) => t.start < 60000)
    const lt20 = allLong.filter((t) => t.start < 20000)

    const prof = aggregateProfile(profile)
    let travelled = 0
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i]
      travelled += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    }

    const out = {
      label: LABEL,
      ts: new Date().toISOString(),
      backend: BACKEND,
      gpu: GPU,
      seconds: SECONDS,
      walk: WALK,
      url,
      viewport: '1280x720@1',
      idleBefore,
      gpuSamples,
      startup: {
        navToIsReadyMs: tReady,
        revealedAtPerfNowMs: tRevealed,
        navToInputAcceptedMs: navToFirstMoveMs,
        terrainPresent: revealed.terrain,
        vegInstances: revealed.veg,
        refreshHz: revealed.refreshHz,
      },
      frames: {
        count: deltas.length,
        minMs: +deltas[0].toFixed(2),
        p50Ms: +percentile(deltas, 0.5).toFixed(2),
        p95Ms: +percentile(deltas, 0.95).toFixed(2),
        p99Ms: +percentile(deltas, 0.99).toFixed(2),
        maxMs: +percentile(deltas, 1).toFixed(2),
        avgMs: +(deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)).toFixed(2),
        fps: +(1000 / Math.max(0.001, percentile(deltas, 0.5))).toFixed(1),
      },
      draws: {
        count: draws.length,
        avg: +(draws.reduce((a, b) => a + b, 0) / Math.max(1, draws.length)).toFixed(1),
        p95: +percentile(draws.slice().sort((a, b) => a - b), 0.95).toFixed(0),
        max: Math.max(0, ...draws),
      },
      glCallsPerFrame: {
        windowFrames: glPerFrame.length,
        avg: +(glPerFrame.reduce((a, b) => a + b, 0) / Math.max(1, glPerFrame.length)).toFixed(1),
        p95: +percentile(glPerFrame, 0.95).toFixed(0),
      },
      glDrawCallsPerFrame: {
        windowFrames: glDrawPerFrame.length,
        avg: +(glDrawPerFrame.reduce((a, b) => a + b, 0) / Math.max(1, glDrawPerFrame.length)).toFixed(1),
        p95: +percentile(glDrawPerFrame, 0.95).toFixed(0),
        max: Math.max(0, ...glDrawPerFrame),
      },
      longTasks: {
        first20s: lt20.length,
        first20sOver100: lt20.filter((t) => t.dur > 100).length,
        first20sMaxMs: +Math.max(0, ...lt20.map((t) => t.dur)).toFixed(1),
        first60s: lt60.length,
        first60sOver100: lt60.filter((t) => t.dur > 100).length,
        first60sMaxMs: +Math.max(0, ...lt60.map((t) => t.dur)).toFixed(1),
        total: inPage.longtasks.length,
      },
      cpuProfile: { totalMs: +prof.totalMs.toFixed(1), top: prof.rows.slice(0, 30).map((r) => ({ fn: r.key, ms: +r.ms.toFixed(1), pct: +r.pct.toFixed(2) })) },
      shadow: inPage.shadow,
      shadowPipeline: inPage.shadowPipeline,
      bootMarks: inPage.marks,
      perfSession: inPage.perf,
      veg: inPage.veg,
      travelledM: +travelled.toFixed(1),
      trackSamples: track.length,
      pageErrors: pageErrors.slice(0, 20),
      consoleErrors: inPage.errors,
      graphStats: inPage.graphStats,
      idleAfter: sampleGpu(),
    }
    writeFileSync(OUT_FILE, JSON.stringify(out, null, 2))
    console.log('\n[perf-run] === ' + LABEL + ' ===')
    console.log(`  gpu=${GPU} backend=${BACKEND} walk=${WALK} ${SECONDS}s  travelled=${out.travelledM}m in ${track.length} samples`)
    console.log(`  frames: n=${out.frames.count} min=${out.frames.minMs}ms p50=${out.frames.p50Ms}ms p95=${out.frames.p95Ms}ms p99=${out.frames.p99Ms}ms fps(p50)=${out.frames.fps}  refreshHz(inferred)=${revealed.refreshHz}`)
    console.log(`  draws/frame avg=${out.draws.avg} p95=${out.draws.p95} max=${out.draws.max}`)
    console.log(`  GL calls/frame avg=${out.glCallsPerFrame.avg} p95=${out.glCallsPerFrame.p95} (n=${out.glCallsPerFrame.windowFrames})`)
    console.log(`  GL draw calls/frame avg=${out.glDrawCallsPerFrame.avg} p95=${out.glDrawCallsPerFrame.p95} max=${out.glDrawCallsPerFrame.max} (n=${out.glDrawCallsPerFrame.windowFrames})`)
    console.log(`  long tasks: 0-20s=${out.longTasks.first20s} (>100ms ${out.longTasks.first20sOver100}, max ${out.longTasks.first20sMaxMs}ms) | 0-60s=${out.longTasks.first60s} (>100ms ${out.longTasks.first60sOver100}, max ${out.longTasks.first60sMaxMs}ms)`)
    console.log(`  errors: pageErrors=${out.pageErrors.length} consoleErrors=${out.consoleErrors.length}`)
  for (const e of out.pageErrors.slice(0, 6)) console.log('    pageerror: ' + e)
  for (const e of out.consoleErrors.slice(0, 6)) console.log('    console: ' + e)
  console.log(`  startup: nav->isReady=${tReady}ms  overlayHidden=${tRevealed}ms  nav->inputAccepted=${navToFirstMoveMs}ms`)
    console.log(`  boot marks: ${inPage.marks.map((m) => m.name + '=' + m.at + 'ms').join('  ')}`)
    console.log(`  shadow: ${JSON.stringify(inPage.shadow)}`)
    console.log(`  vegProfile: ${JSON.stringify(inPage.vegProfile)}`)
    console.log(`  graph node stats: ${JSON.stringify(inPage.graphStats)}`)
    console.log(`  cpu profile total=${out.cpuProfile.totalMs}ms`)
    for (const r of out.cpuProfile.top.slice(0, 20)) console.log(`    ${r.pct.toFixed(2)}%  ${r.ms}ms  ${r.fn}`)
    console.log(`  gpu idle after: ${JSON.stringify(out.idleAfter)}`)
    console.log(`  written ${OUT_FILE}`)
  } finally {
    if (browser) await browser.close()
    server.stop()
  }
  process.exit(0)
}

main().catch((e) => { console.error('[perf-run] FATAL', e.stack || e.message); process.exit(1) })
