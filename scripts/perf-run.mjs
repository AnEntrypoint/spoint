#!/usr/bin/env node
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync, spawn } from 'node:child_process'
import { chromium } from './lib/cdp-browser.mjs'
import { unreachedReasons } from './lib/witness-reachability.mjs'
import { assertGpu, gpuArgs } from './lib/gpu-probe.mjs'

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
const ROUTE = flag('walk-route', '')
const WALK_SPEED = Number(flag('walk-speed', '7'))
const WALKER = ROUTE.length > 0
const [VIEW_W, VIEW_H] = String(flag('viewport', '1280x720')).split('x').map(Number)
const GPU_PASSES = has('gpu-passes')
const SERVE_ROOT = resolve(String(flag('serve-root', ROOT)))
const WORKTREE_META = has('worktree-meta') ? JSON.parse(readFileSync(String(flag('worktree-meta', '')), 'utf8')) : null
const SERVER_ONLY = has('server-only')
const INPUT_WAIT_EFFECTIVE_MS = WALKER ? 0 : INPUT_WAIT_MS
const ROUTE_WAYPOINTS = ROUTE ? ROUTE.split(';').map((p) => { const n = p.split(',').map(Number); return { x: n[0], z: n[1] } }) : []
const RELOCATE = /(^|&)(at|bookmark)=/.test(EXTRA_QUERY)
const HEIGHT_PROBE = has('probe-heights')
const HARD_TIMEOUT_MS = Number(flag('hard-timeout', '600000'))
const REQUIRED_MARKS = String(flag('require-mark', 'boot:scenery-built')).split(',').map((s) => s.trim()).filter(Boolean)
const REQUIRED_COUNTS = String(flag('require-count', 'draws,frames')).split(',').map((s) => s.trim()).filter(Boolean)
const REQUIRE_ACCELERATED = has('require-accelerated')
const EXPECT_VENDOR = flag('expect-vendor', null)
let spawnedChromePid = null
let witnessUnreached = []
let reachabilityUnreached = []
setTimeout(() => {
  console.log('[perf-run] HARD TIMEOUT after ' + HARD_TIMEOUT_MS + 'ms -- abandoning run')
  if (spawnedChromePid && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(spawnedChromePid), '/T', '/F'], { stdio: 'ignore' })
  process.exit(3)
}, HARD_TIMEOUT_MS).unref()
const OUT_FILE = resolve(OUT_DIR, LABEL + '.json')

const GPU_VENDOR_ARGS = {
  nvidia: ['--use-gl=angle', '--use-angle=d3d11'],
  igpu: ['--use-gl=angle', '--use-angle=d3d11', '--igpu-select'],
  amd: ['--use-gl=angle', '--use-angle=d3d11', '--use-adapter-luid=0,' + flag('adapter-luid', '')],
}
const ACCELERATED = has('accelerated') || GPU !== 'swiftshader'
const LAUNCH_ARGS = ACCELERATED
  ? [...gpuArgs({ accelerated: true }), ...(GPU_VENDOR_ARGS[GPU] || GPU_VENDOR_ARGS.nvidia)]
  : gpuArgs({ accelerated: false })

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
  const rig = { frames: [], longtasks: [], errors: [], heapSamples: 0, glWindow: null, navStart: performance.timeOrigin }
  W.__rig = rig
  W.__rigGlCount = 0
  W.__rigGlDraws = 0
  W.__rigGlOn = false
  W.__rigWgpuCount = 0
  W.__rigWgpuDraws = 0
  W.__rigWgpuOn = false
  W.__rigThreeDraws = 0
  W.__rigThreeTris = 0
  W.__rigRenderCalls = 0
  const WGPU_DRAWF = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'])
  const WGPU_PROTOS = ['GPUDevice', 'GPUQueue', 'GPUCommandEncoder', 'GPURenderPassEncoder', 'GPUComputePassEncoder', 'GPURenderBundleEncoder', 'GPUCanvasContext']
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
  const patchProto = (proto) => {
    if (!proto) return
    const names = Object.getOwnPropertyNames(proto)
    for (let i = 0; i < names.length; i++) {
      const k = names[i]
      if (k === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(proto, k)
      if (!d || typeof d.value !== 'function') continue
      const orig = d.value
      Object.defineProperty(proto, k, {
        value: function () {
          if (W.__rigWgpuOn) { W.__rigWgpuCount++; if (WGPU_DRAWF.has(k)) W.__rigWgpuDraws++ }
          return orig.apply(this, arguments)
        },
        writable: true, configurable: true,
      })
    }
  }
  for (let i = 0; i < WGPU_PROTOS.length; i++) if (W[WGPU_PROTOS[i]] && W[WGPU_PROTOS[i]].prototype) patchProto(W[WGPU_PROTOS[i]].prototype)
  const hookRenderer = (renderer) => {
    if (!renderer || renderer.__rigHooked) return
    renderer.__rigHooked = true
    const info = renderer.info
    if (info) {
      const origReset = info.reset
      info.reset = function () {
        W.__rigThreeDraws += info.render.drawCalls !== undefined ? info.render.drawCalls : info.render.calls
        W.__rigThreeTris += info.render.triangles || 0
        return origReset.apply(this, arguments)
      }
    }
    const origRender = renderer.render
    renderer.render = function () {
      W.__rigRenderCalls++
      return origRender.apply(this, arguments)
    }
  }
  let last = -1
  function tick(now) {
    const dt = last < 0 ? 0 : now - last
    last = now
    const renderer = W.__app && W.__app.renderer
    if (renderer) hookRenderer(renderer)
    if (rig.frames.length < 400000) rig.frames.push([+now.toFixed(2), +dt.toFixed(2), W.__rigThreeDraws, W.__rigGlOn ? W.__rigGlCount : -1, W.__rigGlOn ? W.__rigGlDraws : -1, W.__rigThreeTris, W.__rigWgpuOn ? W.__rigWgpuCount : -1, W.__rigWgpuOn ? W.__rigWgpuDraws : -1, W.__rigRenderCalls])
    if (W.__rigHeapOn && performance.memory && rig.heapSamples < 400000) { rig.heapSamples++; W.__rigHeap.push(performance.memory.usedJSHeapSize) }
    requestAnimationFrame(tick)
  }
  W.__rigHeap = []
  W.__rigHeapOn = false
  requestAnimationFrame(tick)
})()`

const GPU_PASS_ARM_SRC = `(() => {
  const r = window.__app && window.__app.renderer
  if (!r || !r.backend) return { error: 'no renderer' }
  const b = r.backend
  const hasFeature = !!(b.device && b.device.features && b.device.features.has('timestamp-query'))
  if (!b.trackTimestamp) return { error: 'timestamp tracking off (needs ?gputime=1 and the timestamp-query feature)', trackTimestamp: false, hasFeature }
  const meta = new Map()
  const origUid = b.updateTimeStampUID.bind(b)
  b.updateTimeStampUID = function (ctx) {
    if (!meta.has(ctx.id)) {
      const rt = ctx.renderTarget
      meta.set(ctx.id, { compute: !!ctx.isComputeNode, target: rt ? (rt.width + 'x' + rt.height + (rt.name ? ':' + rt.name : '')) : 'canvas', scene: ctx.scene ? (ctx.scene.name || ctx.scene.type) : null, camera: ctx.camera ? (ctx.camera.name || ctx.camera.type) : null, shadowCamera: !!(ctx.camera && ctx.camera.isOrthographicCamera && rt) })
    }
    return origUid(ctx)
  }
  const tally = new Map()
  const perFrameTotals = []
  const drain = async () => {
    for (const type of ['render', 'compute']) {
      try { await r.resolveTimestampsAsync(type) } catch (_) { continue }
      const pool = b.timestampQueryPool && b.timestampQueryPool[type]
      if (!pool) continue
      const byFrame = new Map()
      for (const [uid, ms] of pool.timestamps) {
        const parts = uid.split(':')
        const key = type + ':' + parts[2]
        if (type === 'render') { const fr = parts[3]; byFrame.set(fr, (byFrame.get(fr) || 0) + ms) }
        const t = tally.get(key) || { n: 0, sum: 0, max: 0 }
        t.n++; t.sum += ms; if (ms > t.max) t.max = ms
        tally.set(key, t)
      }
      pool.timestamps.clear()
      if (type === 'render') { const frames = [...byFrame.keys()].sort((a, c) => Number(a.slice(1)) - Number(c.slice(1))); frames.pop(); for (const fr of frames) if (perFrameTotals.length < 100000) perFrameTotals.push(+byFrame.get(fr).toFixed(4)) }
    }
  }
  const iv = setInterval(drain, 250)
  window.__rigPassStop = async () => {
    clearInterval(iv)
    await drain()
    const passes = []
    for (const [key, t] of tally) {
      const id = key.split(':')[1]
      const m = meta.get(id) || meta.get(Number(id)) || {}
      passes.push({ type: key.split(':')[0], ctx: id, ...m, samples: t.n, avgMs: +(t.sum / t.n).toFixed(4), maxMs: +t.max.toFixed(3), totalMs: +t.sum.toFixed(2) })
    }
    passes.sort((a, c) => c.totalMs - a.totalMs)
    perFrameTotals.sort((a, c) => a - c)
    const pc = (p) => perFrameTotals.length ? perFrameTotals[Math.min(perFrameTotals.length - 1, Math.floor(p * perFrameTotals.length))] : null
    return { hasFeature, canvas: r.domElement ? r.domElement.width + 'x' + r.domElement.height : null, frameGpuMs: { n: perFrameTotals.length, p50: pc(0.5), p95: pc(0.95), p99: pc(0.99) }, passes }
  }
  return { ok: true, hasFeature }
})()`

const GPU_PROBE_PS1 = resolve(OUT_DIR, 'gpu-probe.ps1')
const GATE_PROBE_REPO = resolve(__dirname, 'perf-run-gate.ps1')
const GPU_PROBE_FALLBACK = `$e = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
$s = 0
foreach ($x in $e) { if ($x.Name -match 'engtype_3D') { $s += [double]$x.UtilizationPercentage } }
$t = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome-headless-shell.exe'" | Where-Object { $_.CommandLine -match 'dev.train' }).Count
$all = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='chrome-headless-shell.exe'").Count
$c = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
Write-Output "gpu3d=$s train=$t chrome=$all cpu=$c"`
const GPU_PROBE_SRC = existsSync(GATE_PROBE_REPO) ? readFileSync(GATE_PROBE_REPO, 'utf8') : GPU_PROBE_FALLBACK

const HOST_CPU_PS1 = resolve(__dirname, 'perf-run-hostcpu.ps1')
const HOST_CPU_CONTENDED_PCT = 90
function parseHostCpu(out) {
  const all = /all=(\d+)/.exec(out), cores = /cores=(\d+)/.exec(out), top = /top=(.*)$/m.exec(out)
  const procsLine = /procs=(.*)$/m.exec(out)
  const topProcs = procsLine ? procsLine[1].trim().split(';').filter(Boolean).map((r) => { const [pid, name, cores, ...cmd] = r.split('|'); return { pid: Number(pid), name, cores: Number(cores), cmd: cmd.join('|') } }) : []
  return { topProcs, allPct: all ? Number(all[1]) : null, cores: cores ? Number(cores[1]) : null, topCores: top ? top[1].trim().split(',').filter(Boolean).map((t) => { const i = t.lastIndexOf(':'); return [t.slice(0, i), Number(t.slice(i + 1))] }) : [] }
}
function sampleHostCpuSync() {
  const r = spawnSync('powershell', ['-NoProfile', '-File', HOST_CPU_PS1], { encoding: 'utf8' })
  return parseHostCpu(r.stdout || '')
}
function sampleHostCpuAsync(into, t0) {
  const c = spawn('powershell', ['-NoProfile', '-File', HOST_CPU_PS1])
  let out = ''
  c.stdout.on('data', (d) => { out += d })
  c.on('close', () => into.push({ t: Date.now() - t0, ...parseHostCpu(out) }))
}

function sampleGpu() {
  const r = spawnSync('powershell', ['-NoProfile', '-File', GPU_PROBE_PS1], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  const num = (re) => { const m = re.exec(out); return m ? Number(m[1]) : null }
  return { gpu3d: num(/gpu3d=([\d.]+)/), train: num(/train=(\d+)/), gm: num(/gm=(\d+)/), perf: num(/perf=(\d+)/), other: num(/other=(\d+)/), user: num(/user=(\d+)/), chrome: num(/chrome=(\d+)/), cpu: num(/cpu=(\d+)/) }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

function aggregateProfile(profile) {
  if (!profile || !profile.nodes) return { totalMs: 0, rows: [] }
  const byId = new Map()
  for (const n of profile.nodes) byId.set(n.id, n)
  const self = new Map()
  const incl = new Map()
  const parentOf = new Map()
  for (const n of profile.nodes) for (const c of (n.children || [])) parentOf.set(c, n.id)
  const keyOf = (n) => { const cf = n.callFrame || {}; return (cf.functionName || '(anon)') + ' @ ' + shortUrl(cf.url) + ':' + (cf.lineNumber != null ? cf.lineNumber + 1 : '?') }
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
    const seen = new Set()
    for (let a = n; a; a = byId.get(parentOf.get(a.id))) {
      const k = a === n ? key : keyOf(a)
      if (seen.has(k)) continue
      seen.add(k)
      incl.set(k, (incl.get(k) || 0) + us)
    }
  }
  const rows = [...self.entries()].map(([k, us]) => ({ key: k, ms: us / 1000, pct: total ? (100 * us) / total : 0 }))
  rows.sort((a, b) => b.ms - a.ms)
  const inclRows = [...incl.entries()].map(([k, us]) => ({ key: k, ms: us / 1000, pct: total ? (100 * us) / total : 0 }))
  inclRows.sort((a, b) => b.ms - a.ms)
  return { totalMs: total / 1000, rows, inclRows }
}

function shortUrl(u) {
  if (!u) return ''
  const s = String(u)
  const i = s.lastIndexOf('/')
  return i < 0 ? s : s.slice(i + 1)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  for (let attempt = 0; attempt < 6; attempt++) {
    try { writeFileSync(GPU_PROBE_PS1, GPU_PROBE_SRC); break } catch (e) {
      if (e && e.code !== 'EBUSY') throw e
      if (attempt === 5) { console.log('[perf-run] gpu-probe.ps1 locked, reusing on-disk copy'); break }
      await new Promise(r => setTimeout(r, 500))
    }
  }
  const port = String(20000 + Math.floor(Math.random() * 20000))
  process.env.WORLD = process.env.WORLD || 'tps-game'
  process.env.PORT = port
  process.env.SPOINT_NO_WATCH = '1'
  if (has('skip-prewarm')) process.env.SPOINT_SKIP_PREWARM = '1'

  const idleBefore = sampleGpu()
  const hostCpuBefore = sampleHostCpuSync()
  const hostCpuDuring = []
  console.log('[perf-run] host cpu before: ' + JSON.stringify(hostCpuBefore))
  console.log(`[perf-run] idle probe before: gpu3d=${idleBefore.gpu3d} trainChrome=${idleBefore.train}`)

  console.log(`[perf-run] booting real server on ${port} (world=${process.env.WORLD}) ...`)
  if (SERVE_ROOT !== ROOT) process.chdir(SERVE_ROOT)
  const { boot } = await import(pathToFileURL(resolve(SERVE_ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()
  console.log('[perf-run] server up from ' + SERVE_ROOT + (WORKTREE_META ? ' (worktree commit ' + WORKTREE_META.commit + ')' : ''))
  if (SERVER_ONLY) {
    const identity = await (await fetch(`http://127.0.0.1:${port}/__identity`)).json().catch((e) => ({ error: e.message }))
    const appBytes = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/app.js`)).arrayBuffer())
    const servedAppSha = createHash('sha256').update(appBytes).digest('hex').slice(0, 16)
    console.log('[perf-run] server-only: ' + JSON.stringify({ port, identity, servedAppSha, servedAppBytes: appBytes.length, worktree: WORKTREE_META }))
    server.stop()
    process.exit(0)
  }

  const args = [...LAUNCH_ARGS]
  args.push('--enable-precise-memory-info')
  if (GPU === 'igpu') args.push('--disable-features=UseGpuPreferenceForGpuProcess')
  let browser
  const gpuSamples = []
  try {
    browser = await chromium.launch({ headless: true, args })
    spawnedChromePid = browser.pid
    const pidRecord = { label: LABEL, nodePid: process.pid, chromePid: browser.pid, profileDir: browser.profileDir, startedAt: new Date().toISOString() }
    writeFileSync(resolve(OUT_DIR, LABEL + '.pids.json'), JSON.stringify(pidRecord))
    console.log('[perf-run] spawned: ' + JSON.stringify(pidRecord))
    const page = await browser.newPage({ viewport: { width: VIEW_W, height: VIEW_H } })
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
    await page._send('Profiler.enable').catch(() => {})
    await page._send('Performance.enable').catch(() => {})
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

    const gpu = await assertGpu(page, { requireAccelerated: REQUIRE_ACCELERATED, expectVendor: EXPECT_VENDOR }).catch((e) => ({ rasterizer: 'unknown', renderer: null, vendor: null, adapter: null, haystack: null, error: e.message }))
    console.log(`[perf-run] rasterizer=${gpu.rasterizer}${gpu.error ? ' probeError=' + gpu.error : ''} renderer=${gpu.renderer || 'none'} webgpu=${gpu.adapter ? (gpu.adapter.description || gpu.adapter.vendor || 'yes') : 'none'}`)

    let navToFirstMoveMs = null
    let navToInputSeqMs = null
    let navToInputProbeStart = null
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
      navToInputProbeStart = tInput - tNav
      console.log(`[perf-run] input probe start: nav+${navToInputProbeStart}ms (overlayHidden at ${tRevealed}ms perf.now, so ${navToInputProbeStart - Math.round(tRevealed)}ms of that is harness overhead)`)
      const probeLegs = ['KeyW', 'KeyD', 'KeyS', 'KeyA']
      let probeIdx = 0
      let probeDown = null
      let maxD = 0
      let loggedDrive = false
      let sawVelocity = null
      let probeDumpAt = 0
      let probeDumps = 0
      const seqOf = () => page.evaluate(() => {
        const s = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
        const i = window.__rigLastInput
        return { seq: s ? s.inputSequence : null, input: i || null }
      }).catch(() => null)
      const seq0 = await seqOf()
      const moved = await (async () => {
        while (Date.now() - tInput < INPUT_WAIT_EFFECTIVE_MS) {
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
    if (!WALKER && navToInputSeqMs === null) console.log('[perf-run] ASSERT FAILED: synthetic keys never reached the app input bucket (nav->inputReachedGame=null) -- this arm measured a standing player')

    const gpuTimer = setInterval(() => gpuSamples.push({ t: Date.now() - tNav, ...sampleGpu() }), 5000)
    const hostCpuTimer = setInterval(() => sampleHostCpuAsync(hostCpuDuring, tNav), 10000)

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

    console.log('[perf-run] step: clear startup samples')
    await page.evaluate(() => {
      const r = window.__rig
      if (!r) return
      r.startupLongtasks = r.longtasks.slice()
      r.longtasks.length = 0
      r.frames.length = 0
    }).catch(() => {})
    console.log('[perf-run] step: perf reset')
    await page.evaluate(() => { const p = window.__perf; if (p && p.reset) p.reset() }).catch(() => {})
    const adapterInfo = await page.evaluate(async () => { try { const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); return a && a.info ? { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description } : null } catch (e) { return { error: String(e && e.message || e) } } }).catch(() => null)
    console.log('[perf-run] webgpu adapter: ' + JSON.stringify(adapterInfo))
    const metricsBefore = await page._send('Performance.getMetrics').then((r) => Object.fromEntries(r.metrics.map((m) => [m.name, m.value]))).catch(() => null)
    if (GPU_PASSES) {
      const armed = await page.evaluate(GPU_PASS_ARM_SRC).catch((e) => ({ error: e.message }))
      console.log('[perf-run] gpu passes: ' + JSON.stringify(armed))
    }
    await page.evaluate(() => { window.__rigHeap.length = 0; window.__rigHeapOn = true }).catch(() => {})
    console.log('[perf-run] step: Profiler.setSamplingInterval + start')
    await page._send('Profiler.setSamplingInterval', { interval: 5000 }).catch(() => {})
    await page._send('Profiler.start').catch(() => {})
    if (RELOCATE) {
      console.log('[perf-run] step: relocation settle')
      const rel = await page.evaluate(async () => {
        const s = window.__spoint
        if (!s) return { error: 'no __spoint' }
        try { await s.whenSettled({ tolerance: 0.02, timeoutMs: 60000 }) } catch (e) { return { error: String((e && e.message) || e), boot: window.__spointBoot || null } }
        return { boot: window.__spointBoot || null, where: s.where ? s.where() : null }
      }).catch((e) => ({ error: e.message }))
      console.log('[perf-run] relocation: ' + JSON.stringify(rel).slice(0, 400))
    }
    const walkSeqStart = await page.evaluate(() => { const s = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null; return s ? s.inputSequence : null }).catch(() => null)
    if (WALKER) {
      const started = await page.evaluate(({ route, speed }) => {
        const s = window.__spoint
        if (!s || !s.route) return { error: 'no __spoint.route' }
        window.__walkDone = null
        s.route(route, { mode: 'walk', speed, settle: false, timeoutMs: 600000 })
          .then((r) => { window.__walkDone = { legs: r.length, last: r[r.length - 1] } })
          .catch((e) => { window.__walkDone = { error: String((e && e.message) || e) } })
        return { ok: true }
      }, { route: ROUTE_WAYPOINTS, speed: WALK_SPEED }).catch((e) => ({ error: e.message }))
      console.log('[perf-run] walker: ' + JSON.stringify(started))
    }
    if (HEIGHT_PROBE) {
      const armed = await page.evaluate(() => {
        const t = window.__terrain
        if (!t || !t.frame) return { error: 'no __terrain.frame' }
        const f = t.frame
        const stats = { gh: 0, hAt: 0, prefetch: 0, patchNull: 0, stacks: {} }
        window.__heightProbe = stats
        const wrap = (obj, key, name) => {
          const orig = obj[key]
          if (typeof orig !== 'function') return
          obj[key] = function (...a) {
            stats[name]++
            if (stats[name] % 500 === 0) {
              const line = ((new Error()).stack || '').split('\n').slice(2, 5).join(' | ')
              stats.stacks[line] = (stats.stacks[line] || 0) + 1
            }
            return orig.apply(this, a)
          }
        }
        wrap(f, 'groundHeightLocal', 'gh')
        wrap(f, '_patchPrefetch', 'prefetch')
        wrap(f, '_patchHeightOrNull', 'patchNull')
        wrap(t, 'heightAt', 'hAt')
        return { ok: true }
      }).catch((e) => ({ error: e.message }))
      console.log('[perf-run] height probe: ' + JSON.stringify(armed))
    }

    const walkStart = Date.now()
    const legs = WALK ? ['KeyW', 'KeyD', 'KeyS', 'KeyA'] : []
    const targetEnd = walkStart + SECONDS * 1000
    let held = null
    const track = []
    let track0 = null
    let lastTrackAt = 0
    let glArmed = false
    while (Date.now() < targetEnd) {
      if (WALK && !WALKER) {
        const idx = Math.floor((Date.now() - walkStart) / LEG_MS) % legs.length
        const code = legs[idx]
        if (code !== held) {
          if (held) {
            console.log(`[perf-run] step: release ${held} at t+${Date.now() - walkStart}ms`)
            await page.keyboard.up(held).catch(() => {})
          }
          console.log(`[perf-run] step: hold ${code} at t+${Date.now() - walkStart}ms`)
          await page.keyboard.down(code).catch(() => {})
          held = code
        }
      }
      const slice = Math.min(1000, targetEnd - Date.now())
      await new Promise((r) => setTimeout(r, Math.max(0, slice)))
      const now = Date.now()
      const elapsed = now - walkStart
      if (now - lastTrackAt >= 5000) {
        lastTrackAt = now
        const pos = await readPos()
        if (pos) { track.push(pos[1]); if (!track0) track0 = pos[1] }
      }
      if (elapsed >= 3000 && !glArmed) { glArmed = true; await page.evaluate(() => { window.__rigGlOn = true; window.__rigGlCount = 0; window.__rigGlDraws = 0; window.__rigWgpuOn = true; window.__rigWgpuCount = 0; window.__rigWgpuDraws = 0 }).catch(() => {}) }
      if (elapsed >= 13000 && glArmed) { glArmed = false; await page.evaluate(() => { window.__rigGlOn = false; window.__rigWgpuOn = false }).catch(() => {}) }
    }
    if (held) {
      console.log(`[perf-run] step: release ${held} at end`)
      await page.keyboard.up(held).catch(() => {})
    }
    const walkMs = Date.now() - walkStart
    const maxDelta = track0 ? track.reduce((m, p) => Math.max(m, Math.hypot(p[0] - track0[0], p[1] - track0[1], p[2] - track0[2])), 0) : 0
    console.log(`[perf-run] walk done in ${walkMs}ms, track samples=${track.length}, maxDelta=${maxDelta.toFixed(2)}m`)
    if (WALKER) console.log('[perf-run] walker result: ' + JSON.stringify(await page.evaluate(() => window.__walkDone || null).catch(() => null)))
    if (HEIGHT_PROBE) console.log('[perf-run] height probe result: ' + JSON.stringify(await page.evaluate(() => window.__heightProbe || null).catch(() => null)).slice(0, 3000))
    if (WALK && maxDelta < 1) console.log(`[perf-run] ASSERT FAILED: player moved ${maxDelta.toFixed(3)}m over ${SECONDS}s -- not real movement`)

    clearInterval(gpuTimer)
    clearInterval(hostCpuTimer)
    const metricsAfter = await page._send('Performance.getMetrics').then((r) => Object.fromEntries(r.metrics.map((m) => [m.name, m.value]))).catch(() => null)
    const gpuPassResult = GPU_PASSES ? await page.evaluate(() => window.__rigPassStop ? window.__rigPassStop() : null).catch((e) => ({ error: e.message })) : null
    const walkSeqEnd = await page.evaluate(() => { const s = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null; return s ? s.inputSequence : null }).catch(() => null)
    console.log('[perf-run] step: final Profiler.stop')
    let profile = null
    try {
      const stopped = await Promise.race([
        page._send('Profiler.stop'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Profiler.stop exceeded 60s')), 60000)),
      ])
      profile = stopped.profile
    } catch (e) {
      console.log('[perf-run] cpu profile unavailable: ' + e.message)
    }
    console.log('[perf-run] step: read in-page results')

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
        resourceFailures: performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400 && !/favicon/.test(e.name)).slice(0, 20).map((e) => e.responseStatus + ' ' + e.name),
        perf, shadow, veg,
        refreshHz: window.__vsync ? window.__vsync.refreshHz : null,
        rendererInfo: window.__app && window.__app.renderer ? { calls: window.__app.renderer.info.render.calls, drawCalls: window.__app.renderer.info.render.drawCalls, tris: window.__app.renderer.info.render.triangles, programs: window.__app.renderer.info.programs ? window.__app.renderer.info.programs.length : null } : null,
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
        vegSpans: performance.getEntriesByType('measure').filter((m) => m.name.startsWith('boot:veg:')).map((m) => ({ name: m.name.slice(9), start: +m.startTime.toFixed(1), ms: +m.duration.toFixed(1) })),
        measures: performance.getEntriesByType('measure').map((m) => ({ name: m.name, at: +m.startTime.toFixed(1), dur: +m.duration.toFixed(1) })),
      }
    })

    const deltas = inPage.frames.filter((f) => f[1] > 0).map((f) => f[1]).sort((a, b) => a - b)
    const frameDiffs = (idx) => {
      const seq = inPage.frames.filter((f) => f[idx] >= 0).map((f) => f[idx])
      const out = []
      for (let i = 1; i < seq.length; i++) { const d = seq[i] - seq[i - 1]; if (d >= 0) out.push(d) }
      return out
    }
    const threeDraws = frameDiffs(2)
    const tris = frameDiffs(5)
    const renderCalls = frameDiffs(8)
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
    const wgpuFrames = inPage.frames.filter((f) => f[6] >= 0 && f[7] >= 0)
    const wgpuPerFrame = []
    const wgpuDrawPerFrame = []
    for (let i = 1; i < wgpuFrames.length; i++) {
      const d = wgpuFrames[i][6] - wgpuFrames[i - 1][6]
      const g = wgpuFrames[i][7] - wgpuFrames[i - 1][7]
      if (d > 0) wgpuPerFrame.push(d)
      if (g >= 0) wgpuDrawPerFrame.push(g)
    }
    wgpuPerFrame.sort((a, b) => a - b)
    wgpuDrawPerFrame.sort((a, b) => a - b)
    const wgpuSawDraws = wgpuDrawPerFrame.some((d) => d > 0)
    const draws = wgpuSawDraws ? wgpuDrawPerFrame : glDrawPerFrame

    if (has('skip-after-shot')) console.log('[perf-run] after-shot skipped')
    else {
      console.log('[perf-run] step: capture after-shot')
      await shot(LABEL + '-after')
    }

    const allLong = (inPage.startupLongtasks || []).concat(inPage.longtasks || [])
    const lt60 = allLong.filter((t) => t.start < 60000)
    const lt20 = allLong.filter((t) => t.start < 20000)

    const prof = aggregateProfile(profile)
    if (profile) writeFileSync(resolve(OUT_DIR, LABEL + '.cpuprofile'), JSON.stringify(profile))
    const mainThreadBreakdown = (metricsBefore && metricsAfter) ? (() => { const d = (k) => +(((metricsAfter[k] || 0) - (metricsBefore[k] || 0)) * 1000).toFixed(1); const windowFrames = inPage.frames.filter((fr) => fr[1] > 0).length; return { windowMs: +((metricsAfter.Timestamp - metricsBefore.Timestamp) * 1000).toFixed(1), threadTimeMs: d('ThreadTime'), cpuMsPerFrame: windowFrames ? +(d('ThreadTime') / windowFrames).toFixed(3) : null, scriptMsPerFrame: windowFrames ? +(d('ScriptDuration') / windowFrames).toFixed(3) : null, windowFrames, taskMs: d('TaskDuration'), scriptMs: d('ScriptDuration'), layoutMs: d('LayoutDuration'), styleMs: d('RecalcStyleDuration'), layoutCount: Math.round((metricsAfter.LayoutCount || 0) - (metricsBefore.LayoutCount || 0)), styleRecalcCount: Math.round((metricsAfter.RecalcStyleCount || 0) - (metricsBefore.RecalcStyleCount || 0)), jsHeapUsedEndMB: +((metricsAfter.JSHeapUsedSize || 0) / 1048576).toFixed(1) } })() : null
    const heapStats = await page.evaluate(() => {
      const h = window.__rigHeap || []
      const GC_DROP_BYTES = 131072
      let gc = 0, freed = 0, alloc = 0
      for (let i = 1; i < h.length; i++) { const d = h[i] - h[i - 1]; if (d < -GC_DROP_BYTES) { gc++; freed += -d } else if (d > 0) alloc += d }
      alloc += freed
      const frames = window.__rig ? window.__rig.frames : []
      const secs = frames.length > 1 ? (frames[frames.length - 1][0] - frames[0][0]) / 1000 : 0
      return { samples: h.length, gcDropThresholdBytes: GC_DROP_BYTES, gcCount: gc, gcFreedMB: +(freed / 1048576).toFixed(1), allocMBPerSec: secs ? +((alloc / 1048576) / secs).toFixed(2) : null, allocKBPerFrame: h.length > 1 ? +(alloc / 1024 / (h.length - 1)).toFixed(1) : null, windowSec: +secs.toFixed(1), preciseMemory: h.length > 2 && new Set(h.slice(0, 200)).size > 20 }
    }).catch(() => null)
    let travelled = 0
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i]
      travelled += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    }

    const out_drawsAvg = +(draws.reduce((a, b) => a + b, 0) / Math.max(1, draws.length)).toFixed(1)
    const out_threeDrawsAvg = +(threeDraws.reduce((a, b) => a + b, 0) / Math.max(1, threeDraws.length)).toFixed(1)
    const sceneryBuiltMarked = inPage.marks.some((m) => m.name === 'boot:scenery-built')
    const vegTotal = inPage.veg ? inPage.veg.totalInstances : 0
    const drawsMeasured = draws.length > 0 && draws.some((d) => d > 0)
    const walkDone = WALKER ? await page.evaluate(() => window.__walkDone || null).catch(() => null) : null
    const walkOk = !WALKER || (!(walkDone && walkDone.error) && travelled >= 30)
    const seqAdvanced = typeof walkSeqStart === 'number' && typeof walkSeqEnd === 'number' && walkSeqEnd > walkSeqStart
    const inputReached = !WALKER || navToInputSeqMs !== null || seqAdvanced || travelled >= 30
    const APP_LOAD_ERROR = /Failed to resolve module specifier|AppLoader|Failed to fetch dynamically imported module|Cannot find module|module resolution|app load failed|failed to load app|Failed to load resource/i
    const appLoadErrors = [...(inPage.errors || []), ...pageErrors].filter((e) => APP_LOAD_ERROR.test(e)).concat((inPage.resourceFailures || []).filter((e) => !/.(map)$/.test(e))).slice(0, 12)
    const appLoadOk = appLoadErrors.length === 0
    const expectVendor = GPU === 'amd' ? 'amd' : (GPU === 'nvidia' ? 'nvidia' : null)
    const adapterOk = !expectVendor || !!(adapterInfo && adapterInfo.vendor === expectVendor)
    const gpuPassesOk = !GPU_PASSES || !!(gpuPassResult && gpuPassResult.passes && gpuPassResult.passes.length > 0)
    const reachability = { sceneryBuiltMarked, vegTotalInstances: vegTotal, vegNonZero: vegTotal > 0, drawsNonZero: drawsMeasured, walkOk, travelledM: +travelled.toFixed(1), inputSequenceStart: walkSeqStart, inputSequenceEnd: walkSeqEnd, inputReachedGameMs: navToInputSeqMs, inputReached, gpuPassesOk, adapterVendor: adapterInfo ? adapterInfo.vendor : null, adapterOk, appLoadOk, appLoadErrors, pass: appLoadOk && adapterOk && sceneryBuiltMarked && vegTotal > 0 && drawsMeasured && walkOk && inputReached && gpuPassesOk }

      if (!reachability.pass) reachabilityUnreached = Object.entries(reachability).filter(([k, v]) => v !== true && (k.endsWith('Ok') || k.endsWith('NonZero') || k === 'sceneryBuiltMarked')).map(([k]) => k)

    witnessUnreached = unreachedReasons({
      marks: inPage.marks,
      requiredMarks: REQUIRED_MARKS,
      counts: { draws: draws.reduce((m, d) => (d > m ? d : m), 0), frames: deltas.length, veg: vegTotal },
      requiredCounts: REQUIRED_COUNTS,
    })

    const vegSpanTotals = {}
    for (const sp of inPage.vegSpans || []) {
      const step = sp.name.slice(sp.name.lastIndexOf(':') + 1)
      const t = vegSpanTotals[step] || (vegSpanTotals[step] = { count: 0, totalMs: 0, maxMs: 0 })
      t.count++; t.totalMs = +(t.totalMs + sp.ms).toFixed(1); t.maxMs = Math.max(t.maxMs, sp.ms)
    }

    const out = {
      label: LABEL,
      ts: new Date().toISOString(),
      backend: BACKEND,
      gpu: GPU,
      rasterizer: gpu.rasterizer,
      gpuHaystack: gpu.haystack || null,
      gpuProbeError: gpu.error || null,
      seconds: SECONDS,
      walk: WALK,
      url,
      viewport: VIEW_W + 'x' + VIEW_H + '@1',
      idleBefore,
      gpuSamples,
      startup: {
        navToIsReadyMs: tReady,
        revealedAtPerfNowMs: tRevealed,
        navToInputAcceptedMs: navToFirstMoveMs,
        navToInputReachedGameMs: navToInputSeqMs,
        navToInputProbeStartMs: navToInputProbeStart,
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
      trianglesPerFrame: {
        count: tris.length,
        avg: +(tris.reduce((a, b) => a + b, 0) / Math.max(1, tris.length)).toFixed(0),
        p95: +percentile(tris.slice().sort((a, b) => a - b), 0.95).toFixed(0),
        max: Math.max(0, ...tris),
      },
      draws: {
        source: wgpuSawDraws ? 'wgpu-encoder-hook' : (glDrawPerFrame.some((d) => d > 0) ? 'gl-context-hook' : 'none'),
        count: draws.length,
        avg: +(draws.reduce((a, b) => a + b, 0) / Math.max(1, draws.length)).toFixed(1),
        p95: +percentile(draws.slice().sort((a, b) => a - b), 0.95).toFixed(0),
        max: Math.max(0, ...draws),
      },
      threeDrawCallsPerFrame: {
        instrument: 'three renderer.info, summed across every info.reset() in the frame',
        count: threeDraws.length,
        avg: +(threeDraws.reduce((a, b) => a + b, 0) / Math.max(1, threeDraws.length)).toFixed(1),
        p95: +percentile(threeDraws.slice().sort((a, b) => a - b), 0.95).toFixed(0),
        max: Math.max(0, ...threeDraws),
      },
      rendererRenderCallsPerFrame: {
        instrument: 'renderer.render() invocations per frame -- NOT draws',
        count: renderCalls.length,
        avg: +(renderCalls.reduce((a, b) => a + b, 0) / Math.max(1, renderCalls.length)).toFixed(1),
        p95: +percentile(renderCalls.slice().sort((a, b) => a - b), 0.95).toFixed(0),
        max: Math.max(0, ...renderCalls),
      },
      drawsInstrument: {
        authoritative: 'api-boundary draw hook',
        authoritativeField: wgpuSawDraws ? 'wgpuDrawsPerFrame' : 'glDrawCallsPerFrame',
        backend: BACKEND,
        note: 'one unit = one draw submitted to the driver; every other draw figure in this project is a different quantity and is not comparable to it',
        apiHookDraws: out_drawsAvg,
        threeSideDraws: out_threeDrawsAvg,
        ratioThreeOverApi: out_drawsAvg > 0 ? +(out_threeDrawsAvg / out_drawsAvg).toFixed(3) : null,
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
      wgpuCallsPerFrame: {
        windowFrames: wgpuPerFrame.length,
        avg: +(wgpuPerFrame.reduce((a, b) => a + b, 0) / Math.max(1, wgpuPerFrame.length)).toFixed(1),
        p95: +percentile(wgpuPerFrame, 0.95).toFixed(0),
      },
      wgpuDrawsPerFrame: {
        windowFrames: wgpuDrawPerFrame.length,
        avg: +(wgpuDrawPerFrame.reduce((a, b) => a + b, 0) / Math.max(1, wgpuDrawPerFrame.length)).toFixed(1),
        p95: +percentile(wgpuDrawPerFrame, 0.95).toFixed(0),
        max: Math.max(0, ...wgpuDrawPerFrame),
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
      cpuProfile: { totalMs: +prof.totalMs.toFixed(1), top: prof.rows.slice(0, 30).map((r) => ({ fn: r.key, ms: +r.ms.toFixed(1), pct: +r.pct.toFixed(2) })), topInclusive: prof.inclRows.slice(0, 30).map((r) => ({ fn: r.key, ms: +r.ms.toFixed(1), pct: +r.pct.toFixed(2) })), gcSelfMs: +(prof.rows.filter((r) => r.key.startsWith('(garbage collector)')).reduce((a, r) => a + r.ms, 0)).toFixed(1) },
      adapterInfo,
      hostCpu: (() => { const after = sampleHostCpuSync(); const peak = Math.max(hostCpuBefore.allPct || 0, after.allPct || 0, ...hostCpuDuring.map((x) => x.allPct || 0)); return { before: hostCpuBefore, during: hostCpuDuring, after, peakAllPct: peak, contendedThresholdPct: HOST_CPU_CONTENDED_PCT, contentionSensitive: peak >= HOST_CPU_CONTENDED_PCT, wallClockMetricsNote: 'frames, fps, long tasks and reveal are wall-clock and contention-sensitive; cpuMsPerFrame (main-thread ThreadTime) and GPU timestamps are the primary metrics' } })(),
      serveRoot: SERVE_ROOT,
      worktree: WORKTREE_META,
      pids: JSON.parse(readFileSync(resolve(OUT_DIR, LABEL + '.pids.json'), 'utf8')),
      mainThreadMs: mainThreadBreakdown,
      heapStats,
      gpuPasses: gpuPassResult,
      shadow: inPage.shadow,
      shadowPipeline: inPage.shadowPipeline,
      bootMarks: inPage.marks,
      vegSpanTotals,
      vegSpans: inPage.vegSpans,
      reachability,
      witnessUnreached,
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
    console.log(`  gpu=${GPU} rasterizer=${out.rasterizer} backend=${BACKEND} walk=${WALK} ${SECONDS}s  travelled=${out.travelledM}m in ${track.length} samples`)
    console.log(`  frames: n=${out.frames.count} min=${out.frames.minMs}ms p50=${out.frames.p50Ms}ms p95=${out.frames.p95Ms}ms p99=${out.frames.p99Ms}ms fps(p50)=${out.frames.fps}  refreshHz(inferred)=${revealed.refreshHz}`)
    console.log(`  draws/frame avg=${out.draws.avg} p95=${out.draws.p95} max=${out.draws.max} (source=${out.draws.source})  tris/frame avg=${out.trianglesPerFrame.avg} p95=${out.trianglesPerFrame.p95}`)
    console.log(`  three renderer.info draws/frame avg=${out.threeDrawCallsPerFrame.avg} p95=${out.threeDrawCallsPerFrame.p95} max=${out.threeDrawCallsPerFrame.max}  (three/api ratio=${out.drawsInstrument.ratioThreeOverApi})`)
    console.log(`  renderer.render() calls/frame avg=${out.rendererRenderCallsPerFrame.avg} p95=${out.rendererRenderCallsPerFrame.p95} max=${out.rendererRenderCallsPerFrame.max} -- scene renders, NOT draws`)
    console.log(`  GL calls/frame avg=${out.glCallsPerFrame.avg} p95=${out.glCallsPerFrame.p95} (n=${out.glCallsPerFrame.windowFrames})`)
    console.log(`  GL draw calls/frame avg=${out.glDrawCallsPerFrame.avg} p95=${out.glDrawCallsPerFrame.p95} max=${out.glDrawCallsPerFrame.max} (n=${out.glDrawCallsPerFrame.windowFrames})`)
    console.log(`  WebGPU calls/frame avg=${out.wgpuCallsPerFrame.avg} p95=${out.wgpuCallsPerFrame.p95} draws/frame avg=${out.wgpuDrawsPerFrame.avg} max=${out.wgpuDrawsPerFrame.max} (n=${out.wgpuCallsPerFrame.windowFrames})`)
    console.log(`  long tasks: 0-20s=${out.longTasks.first20s} (>100ms ${out.longTasks.first20sOver100}, max ${out.longTasks.first20sMaxMs}ms) | 0-60s=${out.longTasks.first60s} (>100ms ${out.longTasks.first60sOver100}, max ${out.longTasks.first60sMaxMs}ms)`)
    console.log(`  reachability: ${reachability.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(reachability)}`)
    console.log(`  witness state reached: ${witnessUnreached.length === 0 ? 'YES' : 'NO -- ' + witnessUnreached.join('; ')}`)
    console.log(`  errors: pageErrors=${out.pageErrors.length} consoleErrors=${out.consoleErrors.length}`)
  for (const e of out.pageErrors.slice(0, 6)) console.log('    pageerror: ' + e)
  for (const e of out.consoleErrors.slice(0, 6)) console.log('    console: ' + e)
  console.log(`  startup: nav->isReady=${tReady}ms  overlayHidden=${tRevealed}ms  nav->inputAccepted=${navToFirstMoveMs}ms`)
    console.log(`  veg span totals: ${JSON.stringify(vegSpanTotals)}`)
    console.log(`  boot marks: ${inPage.marks.map((m) => m.name + '=' + m.at + 'ms').join('  ')}`)
    console.log(`  shadow: ${JSON.stringify(inPage.shadow)}`)
    console.log(`  vegProfile: ${JSON.stringify(inPage.vegProfile)}`)
    console.log(`  graph node stats: ${JSON.stringify(inPage.graphStats)}`)
    console.log(`  main thread ms: ${JSON.stringify(out.mainThreadMs)}`)
    console.log(`  host cpu: peak=${out.hostCpu.peakAllPct}% contentionSensitive=${out.hostCpu.contentionSensitive} before=${JSON.stringify(out.hostCpu.before)} after=${JSON.stringify(out.hostCpu.after)} samples=${out.hostCpu.during.length}`)
    console.log(`  heap: ${JSON.stringify(out.heapStats)}  gcSelfMs(profile)=${out.cpuProfile.gcSelfMs}`)
    if (out.gpuPasses) { console.log(`  gpu frame ms: ${JSON.stringify(out.gpuPasses.frameGpuMs)} canvas=${out.gpuPasses.canvas}`); for (const p of (out.gpuPasses.passes || []).slice(0, 14)) console.log(`    gpu pass ${p.type} ctx${p.ctx} target=${p.target} scene=${p.scene} cam=${p.camera} shadowCam=${p.shadowCamera} avg=${p.avgMs}ms n=${p.samples} total=${p.totalMs}ms`) }
    console.log(`  cpu profile total=${out.cpuProfile.totalMs}ms`)
    for (const r of out.cpuProfile.topInclusive.slice(0, 30)) console.log(`    incl ${r.pct.toFixed(2)}%  ${r.ms}ms  ${r.fn}`)
    for (const r of out.cpuProfile.top.slice(0, 20)) console.log(`    ${r.pct.toFixed(2)}%  ${r.ms}ms  ${r.fn}`)
    console.log(`  gpu idle after: ${JSON.stringify(out.idleAfter)}`)
    console.log(`  written ${OUT_FILE}`)
  } finally {
    if (browser) await browser.close()
    server.stop()
  }
  const unreached = witnessUnreached.concat(reachabilityUnreached.map((k) => `reachability: ${k} is false`))
  if (unreached.length) {
    console.error(`[perf-run] RESULT: FAIL -- witness never reached the state it measured: ${unreached.join('; ')} (required marks: ${REQUIRED_MARKS.join(',') || 'none'}, required counts: ${REQUIRED_COUNTS.join(',') || 'none'})`)
    process.exit(4)
  }
  process.exit(0)
}

main().catch((e) => { console.error('[perf-run] FATAL', e.stack || e.message); process.exit(1) })
