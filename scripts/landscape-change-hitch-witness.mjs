#!/usr/bin/env node
// PERF-landscape-change-hitch-r270-74.
//
// Owner report, verbatim: "hard hitches when the landscape changes".
//
// This witness does not guess which surface stalls. It boots the real client on the accelerated GPU
// arm, walks the player so the landscape actually changes, and measures EVERY node of BOTH frame
// graphs (client/app.js frameGraph + renderGraph) on every frame, by turning the graph's own
// profiling on and summing each node's cost per frame through setProfileHook. A hitch is a long
// frame, so the report is a distribution (p95/p99/max) of wall rAF delta and of main-thread frame
// cost, plus -- the attribution -- each node's worst single-frame cost.
//
// Deliberately NOT registered in scripts/check.mjs: it reaches the browser + GPU, so it rides behind
// scripts/gpulock.mjs, not the gpu-free arm. Run it as:
//   node scripts/gpulock.mjs run <owner> -- node scripts/landscape-change-hitch-witness.mjs
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { witnessGpu } from './lib/gpu-probe.mjs'
import {
  assertServedClientRoot, clientRootTag, rebuildIfRequested, CLIENT_ROOT_BUNDLE,
} from './lib/served-client-root.mjs'

const LABEL = 'landscape-change-hitch-witness'
const LF = String.fromCharCode(10)

function flag(name, dflt = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const PORT = flag('port', '3271')
const WORLD = flag('world', 'tps-game')
const GPU_MODE = flag('gpu', 'accelerated')
const SETTLE_MS = Number(flag('settle', '4000'))
const MEASURE_MS = Number(flag('measure', '60000'))
const LEG_MS = Number(flag('leg', '8000'))
const SPEED = Number(flag('speed', '7'))
const TIMEOUT_MS = Number(flag('timeout', '240000'))
const [VIEW_W, VIEW_H] = String(flag('viewport', DEFAULT_VIEWPORT.width + 'x' + DEFAULT_VIEWPORT.height)).split('x').map(Number)
const WORST_N = Number(flag('worst', '30'))
const WORST_CPU_N = Number(flag('worst-cpu', '6'))
const MIN_COMPILES = Number(flag('min-compiles', '20'))
const HITCH_WALL_MS = Number(flag('hitch-wall', '50'))
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRATCH = resolve(flag('scratch', join(tmpdir(), 'spoint-landscape-hitch')))
// Mutation arm: reintroduce the stall inside one named frame-graph node and watch the instrument
// catch it. --mutate-on=<node id> --mutate-ms=<n> burns <n> ms of main thread in that node, on every
// frame whose index is a multiple of --mutate-every (default 120).
const MUTATE_ON = flag('mutate-on', '')
const MUTATE_MS = Number(flag('mutate-ms', '120'))
const MUTATE_EVERY = Number(flag('mutate-every', '120'))
// --require-async asserts the fix under test is actually live in the page: without it a passing
// "after" run would be indistinguishable from one that never bound at all.
const REQUIRE_ASYNC = hasFlag('require-async')
// --revert-async puts the synchronous pipeline creation BACK: the witness restores the un-wrapped
// Pipelines.getForRender and re-measures. That is the mutation for this fix -- the real defect is
// reintroduced, not simulated -- and an instrument that cannot see it has proved nothing.
const REVERT_ASYNC = hasFlag('revert-async')

function finish(verdict, detail) {
  console.log(`RESULT: ${verdict} arm=${GPU_MODE} label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
const fail = (detail) => finish('FAIL', detail)
const num = (x) => typeof x === 'number' && Number.isFinite(x)
const OPS = {
  '==': (got, want) => Object.is(got, want),
  '<=': (got, want) => num(got) && got <= want,
  '>=': (got, want) => num(got) && got >= want,
  '>': (got, want) => num(got) && got > want,
  '<': (got, want) => num(got) && got < want,
}
const checks = []
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
const jsonLine = (o) => JSON.stringify(o)
// A revealed page is not a measuring page: without a live local player the client renders an idle
// scene, and an idle scene measures nothing. Gate on the player's own authoritative position.
const PLAYABLE_EXPR = `!!(window.__app && window.__app.revealedAt != null && (() => {
  const c = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null
  return c && c.position && Number.isFinite(c.position[0]) && Number.isFinite(c.position[1])
})())`

// ---------------------------------------------------------------------------
// In-page instrument.
//
// Per rAF frame it records: the wall delta since the previous rAF, the app's own main-thread frame
// cost (window.__perf.lastMs, sampled in animate() as performance.now() - frameStart), the summed
// cost of every node of both frame graphs in that frame, how many times each node ran, and the
// counted GPU work units (buffers, bytes, textures, pipelines, shader modules, writeBuffers).
// ---------------------------------------------------------------------------
const INSTALL_SRC = `(() => {
  const W = window
  if (W.__hitchRig) return { ok: false, reason: 'already installed' }
  const rig = { frames: [], errors: [] }
  W.__hitchRig = rig

  const gpuC = { createBuffer: 0, bufferBytes: 0, createTexture: 0, createRenderPipeline: 0, createComputePipeline: 0, createShaderModule: 0, createBindGroup: 0, writeBuffer: 0, writeBytes: 0, submit: 0 }
  const gpuPrev = Object.assign({}, gpuC)
  rig.gpuCounters = gpuC
  function wrapProto(protoName, methodName, onCall) {
    const C = W[protoName]
    if (!C || !C.prototype) return false
    const P = C.prototype
    const d = Object.getOwnPropertyDescriptor(P, methodName)
    if (!d || typeof d.value !== 'function') return false
    const orig = d.value
    Object.defineProperty(P, methodName, {
      value: function () { try { onCall(arguments) } catch (_) {} return orig.apply(this, arguments) },
      writable: true, configurable: true,
    })
    return true
  }
  // Call-site attribution: a create is only an anonymous work unit until it is named. Every
  // pipeline, shader module, texture and buffer is logged with the JS stack that minted it. tick()
  // bumps frameIdx before the app's own frame runs, so an entry's f is exactly the row that owns it.
  // Long tasks are observed separately: a frame whose wall far exceeds its main-thread cost is a
  // stall the node accounting cannot see, and only a longtask entry can place it or rule it out.
  let frameIdx = 0
  const createLog = []
  const tsAt = []
  const longTasks = []
  rig.createLog = createLog
  rig.tsAt = tsAt
  rig.longTasks = longTasks
  const LOG_CAP = 12000
  function logCreate(kind, size, tag, ms) {
    if (createLog.length >= LOG_CAP) return
    if (tag) { createLog.push({ f: frameIdx, kind, size: size || 0, stack: tag, ms: ms || 0 }); return }
    let s = ''
    try { s = new Error().stack || '' } catch (_) { s = '' }
    const lines = s.split('\\n')
    const keep = []
    for (let i = 1; i < lines.length && keep.length < 6; i++) {
      let l = lines[i].trim()
      if (l.indexOf('at ') === 0) l = l.slice(3)
      if (!l || l.indexOf('logCreate') === 0 || l.indexOf('<anonymous>') === 0 || l.indexOf('Object.') === 0 || l.indexOf('Function.') === 0) continue
      keep.push(l)
    }
    createLog.push({ f: frameIdx, kind, size: size || 0, stack: keep.join(' <- '), ms: ms || 0 })
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const att = (e.attribution && e.attribution[0]) || null
        const src = att ? String(att.containerName || '') + '|' + String(att.scriptUrl || att.containerId || '') : String(e.name || '')
        longTasks.push({ start: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1), name: e.name || '', src })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch (_) {}

  // A pipeline is only a work unit until it has an owner. three mints programs inside
  // Pipelines.getForRender(renderObject) during the draw, and renderObject carries the object,
  // material and geometry, so wrapping it names exactly whose first draw is paying the compile.
  const rigOwnerKeys = {}
  const rigOwnerMatIds = new Set()
  rig.ownerKeys = rigOwnerKeys
  rig.ownerMatIds = rigOwnerMatIds
  let pipeHookBound = false
  try {
    const r = W.__app && W.__app.renderer
    const pl = r && (r._pipelines || (r.backend && r.backend.pipelines))
    if (pl) {
      const P = Object.getPrototypeOf(pl)
      const d = Object.getOwnPropertyDescriptor(P, 'getForRender')
      if (d && typeof d.value === 'function') {
        const orig = d.value
        Object.defineProperty(P, 'getForRender', {
          value: function (ro) {
            const before = gpuC.createShaderModule + gpuC.createRenderPipeline
            const out = orig.apply(this, arguments)
            if (gpuC.createShaderModule + gpuC.createRenderPipeline > before) {
              const o = ro && ro.object
              const m = ro && ro.material
              const g = ro && ro.geometry
              const key = 'first-draw of ' + ((o && (o.name || o.type)) || '?') + ' mat=' + ((m && (m.name || m.type)) || '?') + ' geo=' + ((g && g.type) || '?')
              rigOwnerKeys[key] = (rigOwnerKeys[key] || 0) + 1
              if (m && m.id != null) rigOwnerMatIds.add(m.id)
              logCreate('pipelineOwner', 0, key)
            }
            return out
          },
          writable: true, configurable: true,
        })
        pipeHookBound = true
      }
    }
  } catch (_) {}

  // Same idea, but timed: the call is wrapped so its own elapsed time is recorded on the log entry.
  // This is the discriminator between the two synchronous costs under _renderObjectDirect --
  // createShaderModule (always sync) and createRenderPipeline (sync only outside compileAsync) --
  // which no count can separate.
  const gpuMaxMs = {}
  function wrapTimed(protoName, methodName, kind, sizeOf) {
    const C = W[protoName]
    if (!C || !C.prototype) return false
    const P = C.prototype
    const d = Object.getOwnPropertyDescriptor(P, methodName)
    if (!d || typeof d.value !== 'function') return false
    const orig = d.value
    Object.defineProperty(P, methodName, {
      value: function () {
        const t = performance.now()
        const out = orig.apply(this, arguments)
        const ms = performance.now() - t
        gpuC[kind]++
        if (ms > (gpuMaxMs[kind] || 0)) gpuMaxMs[kind] = ms
        logCreate(kind, sizeOf ? sizeOf(arguments) : 0, null, ms)
        return out
      },
      writable: true, configurable: true,
    })
    return true
  }

  const gpuPatched = {}
  gpuPatched.createBuffer = wrapTimed('GPUDevice', 'createBuffer', 'buffer', (a) => (a[0] && a[0].size) || 0)
  gpuPatched.createTexture = wrapTimed('GPUDevice', 'createTexture', 'texture', null)
  gpuPatched.createRenderPipeline = wrapTimed('GPUDevice', 'createRenderPipeline', 'pipeline', null)
  gpuPatched.createRenderPipelineAsync = wrapTimed('GPUDevice', 'createRenderPipelineAsync', 'pipelineAsync', null)
  gpuPatched.createComputePipeline = wrapProto('GPUDevice', 'createComputePipeline', () => { gpuC.createComputePipeline++ })
  gpuPatched.createShaderModule = wrapTimed('GPUDevice', 'createShaderModule', 'shaderModule', null)
  gpuPatched.createBindGroup = wrapProto('GPUDevice', 'createBindGroup', () => { gpuC.createBindGroup++ })
  gpuPatched.writeBuffer = wrapProto('GPUQueue', 'writeBuffer', (a) => { gpuC.writeBuffer++; const data = a[2]; const size = a[4]; gpuC.writeBytes += Number.isFinite(size) ? size : (data && (data.byteLength || data.length)) || 0 })
  gpuPatched.submit = wrapProto('GPUQueue', 'submit', () => { gpuC.submit++ })
  rig.gpuMaxMs = gpuMaxMs
  rig.gpuPatched = gpuPatched

  const graphs = []
  const tags = []
  const fg = W.__frameGraph
  const rg = W.__renderGraph
  if (fg && typeof fg.setProfiling === 'function') { graphs.push(fg); tags.push('frame:') }
  if (rg && typeof rg.setProfiling === 'function') { graphs.push(rg); tags.push('render:') }
  if (!graphs.length) return { ok: false, reason: 'neither __frameGraph nor __renderGraph is exposed' }

  const keys = []
  const idxOf = new Map()
  graphs.forEach((g, gi) => {
    g.setProfiling(true)
    for (const id of g.order) { idxOf.set(tags[gi] + id, keys.length); keys.push(tags[gi] + id) }
  })
  const N = keys.length
  const curMs = new Float64Array(N)
  const curRuns = new Float64Array(N)
  const t0 = new Float64Array(N)
  let active = -1
  // Mutation arm. The burn runs at the head of this node's profileHook.before() -- before the
  // node's own work in that frame -- and t0 is taken AFTER it, so the burn lands in this node's
  // per-frame bucket and nowhere else. It is an instrument self-check: if the report does not name
  // this node as the dominant cost of exactly those frames, the attribution is broken and no
  // conclusion drawn from it is admissible.
  const MUT_NODE = ${JSON.stringify(MUTATE_ON)}
  const MUT_MS = ${JSON.stringify(MUTATE_MS)}
  const MUT_EVERY = Math.max(1, ${JSON.stringify(MUTATE_EVERY)} | 0)
  let mutBurn = null
  if (MUT_NODE) {
    const gi = MUT_NODE.startsWith('frame:') ? 0 : 1
    const bare = MUT_NODE.slice(MUT_NODE.indexOf(':') + 1)
    const g = graphs[gi]
    if (!g) return { ok: false, reason: 'mutate-on names a graph that is not exposed: ' + MUT_NODE }
    if (g.order.indexOf(bare) < 0) return { ok: false, reason: 'mutate-on node is not in that graph order: ' + bare + ' of ' + g.order.join(',') }
    rig.mutation = { node: MUT_NODE, ms: MUT_MS, every: MUT_EVERY, burns: 0 }
    let mutSeen = 0
    mutBurn = (id) => {
      if (id !== bare) return
      mutSeen++
      if (mutSeen % MUT_EVERY !== 0) return
      const t = performance.now()
      while (performance.now() - t < MUT_MS) { }
      rig.mutation.burns++
    }
  }

  graphs.forEach((g, gi) => {
    g.setProfileHook({
      before: (id) => {
        const i = idxOf.get(tags[gi] + id)
        active = i === undefined ? -1 : i
        if (active < 0) return
        if (mutBurn) mutBurn(id)
        t0[active] = performance.now()
        curRuns[active]++
      },
      after: () => { if (active >= 0) { curMs[active] += performance.now() - t0[active]; active = -1 } },
    })
  })
  rig.nodeKeys = keys
  rig.graphOrders = graphs.map((g, gi) => ({ tag: tags[gi], order: [...g.order] }))

  let last = -1
  const rows = rig.frames
  function tick(ts) {
    frameIdx++
    tsAt.push(ts)
    const dt = last < 0 ? 0 : ts - last
    last = ts
    // 0 dt wall, 1 cpu, 2..10 gpu deltas, 11 placement tick, 12..14 scenery population,
    // 15.. per-node ms, 15+N.. per-node runs. The population columns are the "landscape changed"
    // witness: a hitch that is NOT accompanied by a step in these is not the reported defect.
    const row = new Float64Array(N * 2 + 15)
    row[0] = +dt.toFixed(3)
    row[1] = W.__perf ? W.__perf.lastMs : -1
    row[2] = gpuC.createBuffer - gpuPrev.createBuffer
    row[3] = gpuC.bufferBytes - gpuPrev.bufferBytes
    row[4] = gpuC.createTexture - gpuPrev.createTexture
    row[5] = gpuC.createRenderPipeline - gpuPrev.createRenderPipeline
    row[6] = gpuC.createShaderModule - gpuPrev.createShaderModule
    row[7] = gpuC.writeBuffer - gpuPrev.writeBuffer
    row[8] = gpuC.writeBytes - gpuPrev.writeBytes
    row[9] = gpuC.createBindGroup - gpuPrev.createBindGroup
    row[10] = gpuC.submit - gpuPrev.submit
    row[11] = W.__placementTickSeen || 0
    row[12] = (W.__veg && W.__veg.profile && W.__veg.profile.totalInstances) || 0
    row[13] = (W.__grassProfile && W.__grassProfile.totalInstances) || 0
    row[14] = (W.__rocks && W.__rocks.profile && W.__rocks.profile.totalInstances) || 0
    for (const k in gpuC) gpuPrev[k] = gpuC[k]
    for (let i = 0; i < N; i++) { row[15 + i] = +curMs[i].toFixed(3); row[15 + N + i] = curRuns[i] }
    curMs.fill(0); curRuns.fill(0)
    if (rows.length < 200000) rows.push(row)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  rig.sample = () => ({ frames: rig.frames.length })
  return { ok: true, nodes: N, keys, gpuPatched, pipelineOwnerHook: pipeHookBound }
})()`

// Runs in-page at the end: turns the raw per-frame rows into a distribution plus per-node worst
// frame, so only the conclusion crosses the CDP boundary.
const REPORT_SRC = `((args) => {
  const rig = window.__hitchRig
  if (!rig) return { error: 'no __hitchRig' }
  const rows = rig.frames
  const N = rig.nodeKeys.length
  const wall = []
  const cpu = []
  const gpuAgg = { createBuffer: 0, bufferBytes: 0, createTexture: 0, createRenderPipeline: 0, createShaderModule: 0, writeBuffer: 0, writeBytes: 0, createBindGroup: 0 }
  const nodeTotal = new Float64Array(N)
  const nodeMax = new Float64Array(N)
  const nodeMaxFrame = new Int32Array(N).fill(-1)
  const nodeRuns = new Float64Array(N)
  const nodeMs = []
  for (let i = 0; i < N; i++) nodeMs.push([])
  const nodeFramesOver = new Int32Array(N)
  for (let f = 0; f < rows.length; f++) {
    const r = rows[f]
    if (r[0] > 0) wall.push(r[0])
    if (r[1] >= 0) cpu.push(r[1])
    gpuAgg.createBuffer += r[2]; gpuAgg.bufferBytes += r[3]; gpuAgg.createTexture += r[4]
    gpuAgg.createRenderPipeline += r[5]; gpuAgg.createShaderModule += r[6]; gpuAgg.writeBuffer += r[7]
    gpuAgg.writeBytes += r[8]; gpuAgg.createBindGroup += r[9]
    for (let i = 0; i < N; i++) {
      const ms = r[15 + i]
      if (ms <= 0) { nodeRuns[i] += r[15 + N + i]; continue }
      nodeTotal[i] += ms
      nodeRuns[i] += r[15 + N + i]
      if (nodeMs[i].length < 200000) nodeMs[i].push(ms)
      if (ms > args.over) nodeFramesOver[i]++
      if (ms > nodeMax[i]) { nodeMax[i] = ms; nodeMaxFrame[i] = f }
    }
  }
  const pctOf = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(3) }
  const dist = (arr) => ({ n: arr.length, p50: pctOf(arr, 0.5), p95: pctOf(arr, 0.95), p99: pctOf(arr, 0.99), max: arr.length ? +Math.max.apply(null, arr).toFixed(3) : null, avg: arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3) : null })
  const frameDetail = (f) => {
    const r = rows[f]
    const contrib = []
    for (let i = 0; i < N; i++) if (r[15 + i] > 0.05) contrib.push([rig.nodeKeys[i], +r[15 + i].toFixed(2), r[15 + N + i]])
    contrib.sort((a, b) => b[1] - a[1])
    // Each frame owns the creates whose f it was, plus its neighbours: the app's own rAF and this
    // tick are two callbacks in one frame and their order is not guaranteed.
    const agg = {}
    for (const e of rig.createLog) {
      if (e.f < f - 1 || e.f > f + 1) continue
      const k = e.kind + ' :: ' + (e.stack || '(no stack)')
      const a = agg[k] || (agg[k] = { n: 0, bytes: 0, ms: 0 })
      a.n++; a.bytes += e.size; a.ms += e.ms || 0
    }
    const creates = Object.keys(agg).map((k) => ({ call: k, n: agg[k].n, bytes: agg[k].bytes, ms: +agg[k].ms.toFixed(1) })).sort((a, b) => b.ms - a.ms || b.n - a.n || b.bytes - a.bytes)
    // Long tasks inside this frame's own ts window: wall minus main-thread work is either a stall
    // that lives outside animate() (and the node accounting cannot see it) or nothing at all.
    let long = null
    const ta = rig.tsAt[f - 1]
    const tb = rig.tsAt[f]
    if (ta != null && tb != null) {
      const hits = []
      for (const t of rig.longTasks) if (t.start >= ta - 2 && t.start < tb + 2) hits.push(t)
      long = { windowMs: +(tb - ta).toFixed(1), tasks: hits.length, taskMs: +hits.reduce((s, t) => s + t.dur, 0).toFixed(1), worstTaskMs: hits.length ? Math.max.apply(null, hits.map(t => t.dur)) : 0, src: hits.slice(0, 3).map(t => String(t.src || t.name || '?') + '@' + t.dur + 'ms') }
    }
    return {
      frame: f, wallMs: +r[0].toFixed(2), cpuMs: +r[1].toFixed(2),
      top: contrib.slice(0, 8),
      gpu: { buffers: r[2], bufferBytes: r[3], textures: r[4], pipelines: r[5], shaderModules: r[6], writeBuffers: r[7], writeBytes: r[8] },
      pop: { veg: r[12], grass: r[13], rocks: r[14], dVeg: f > 0 ? r[12] - rows[f - 1][12] : 0, dGrass: f > 0 ? r[13] - rows[f - 1][13] : 0, dRocks: f > 0 ? r[14] - rows[f - 1][14] : 0 },
      creates: creates.slice(0, 6),
      long,
    }
  }
  const allFrames = []
  for (let f = 0; f < rows.length; f++) allFrames.push(f)
  const worst = []
  const byWall = allFrames.slice().sort((a, b) => rows[b][0] - rows[a][0])
  for (const f of byWall.slice(0, args.worst)) worst.push(frameDetail(f))
  // A frame whose main-thread cost is huge while its rAF-to-rAF wall is not (or the reverse) is
  // exactly the event one ordering alone mis-orders, so both orderings are reported.
  const worstCpu = []
  const byCpu = allFrames.slice().sort((a, b) => rows[b][1] - rows[a][1])
  for (const f of byCpu.slice(0, args.worstCpu)) worstCpu.push(frameDetail(f))
  const programStacks = {}
  for (const e of rig.createLog) {
    if (e.kind !== 'pipeline' && e.kind !== 'shaderModule' && e.kind !== 'texture') continue
    const k = e.kind + ' :: ' + (e.stack || '(no stack)')
    programStacks[k] = (programStacks[k] || 0) + 1
  }
  const topProgramStacks = Object.keys(programStacks).map((k) => ({ call: k, n: programStacks[k] })).sort((a, b) => b.n - a.n)
  const longTaskTotal = rig.longTasks.reduce((s, t) => s + t.dur, 0)
  const nodes = []
  for (let i = 0; i < N; i++) {
    nodes.push({
      id: rig.nodeKeys[i], totalMs: +nodeTotal[i].toFixed(2), runs: nodeRuns[i],
      maxFrameMs: +nodeMax[i].toFixed(3), maxAtFrame: nodeMaxFrame[i],
      maxFrameWallMs: nodeMaxFrame[i] >= 0 ? +rows[nodeMaxFrame[i]][0].toFixed(2) : null,
      maxFrameCpuMs: nodeMaxFrame[i] >= 0 ? +rows[nodeMaxFrame[i]][1].toFixed(2) : null,
      maxFrameRuns: nodeMaxFrame[i] >= 0 ? rows[nodeMaxFrame[i]][15 + N + i] : null,
      p99FrameMs: pctOf(nodeMs[i], 0.99), p50FrameMs: pctOf(nodeMs[i], 0.5),
      framesOver: nodeFramesOver[i],
    })
  }
  nodes.sort((a, b) => b.maxFrameMs - a.maxFrameMs)
  const hitchWall = Number(args.hitchWall)
  const hitches = []
  for (let f = 0; f < rows.length; f++) if (rows[f][0] >= hitchWall) hitches.push(f)
  const hitchTop = {}
  for (const f of hitches) {
    const r = rows[f]
    let best = -1, bi = -1
    for (let i = 0; i < N; i++) if (r[15 + i] > best) { best = r[15 + i]; bi = i }
    if (bi >= 0) {
      const k = rig.nodeKeys[bi]
      const e = hitchTop[k] || (hitchTop[k] = { count: 0, sumMs: 0, maxMs: 0 })
      e.count++; e.sumMs += best; if (best > e.maxMs) e.maxMs = best
    }
  }
  const hitchAttribution = Object.entries(hitchTop).map(([id, e]) => ({ id, count: e.count, sumMs: +e.sumMs.toFixed(2), maxMs: +e.maxMs.toFixed(2) })).sort((a, b) => b.sumMs - a.sumMs)
  const topOwners = Object.keys(rig.ownerKeys).map((k) => ({ call: k, n: rig.ownerKeys[k] })).sort((a, b) => b.n - a.n)
  return {
    frames: rows.length,
    wall: dist(wall),
    cpu: dist(cpu),
    gpuTotal: gpuAgg,
    nodes,
    worst,
    worstCpu,
    hitchWallMs: hitchWall,
    hitchFrames: hitches.length,
    hitchAttribution,
    mutation: rig.mutation || null,
    topProgramStacks: topProgramStacks.slice(0, 12),
    topOwners: topOwners.slice(0, 15),
    ownerMaterialCount: rig.ownerMatIds.size,
    gpuMaxMs: Object.keys(rig.gpuMaxMs).sort().map((k) => k + '=' + rig.gpuMaxMs[k].toFixed(1) + 'ms'),
    longTasks: { count: rig.longTasks.length, totalMs: +longTaskTotal.toFixed(1), worstMs: rig.longTasks.length ? Math.max.apply(null, rig.longTasks.map(t => t.dur)) : 0 },
  }
})((${JSON.stringify({ worst: WORST_N, worstCpu: WORST_CPU_N, over: 8, hitchWall: HITCH_WALL_MS })}))`

const PROBE = `(() => {
  const a = window.__app || {}
  const cls = (window.__client && window.__client.getLocalState) ? window.__client.getLocalState() : null
  return {
    pos: cls && cls.position ? [+cls.position[0].toFixed(2), +cls.position[1].toFixed(2), +cls.position[2].toFixed(2)] : null,
    perf: window.__perf ? window.__perf.exportSession() : null,
    governor: window.__renderControls ? window.__renderControls.get('qualityGovernor') : null,
    dprOff: window.__renderControls ? window.__renderControls.get('dprOff') : null,
    veg: window.__veg ? (window.__veg.profile && window.__veg.profile.totalInstances) || 0 : 0,
    grass: window.__grassProfile ? window.__grassProfile.totalInstances : 0,
    asyncPipelines: window.__asyncRenderPipelines ? Object.assign({}, window.__asyncRenderPipelines) : null,
    renderer: window.__rendererInfo ? window.__rendererInfo.renderer : null,
  }
})()`

async function browserArm() {
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT
  process.env.SPOINT_NO_WATCH = '1'
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  process.env.SPOINT_STATIC_CACHE_DIR = join(SCRATCH, 'static')
  rebuildIfRequested(LABEL)
  const { boot } = await import(pathToFileURL(resolve(REPO_ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot({ storageDir: join(SCRATCH, 'data') })
  const base = `http://127.0.0.1:${PORT}`

  let browser = null
  const pageErrors = []
  let gpuName = null
  let servedRoot = null
  let report = null
  let travelled = 0
  try {
    browser = await chromium.launch({ headless: false, args: vendorLaunchArgs(GPU_MODE) })
    const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
    page.on('pageerror', e => pageErrors.push(String(e)))
    // The mutation has to be live BEFORE the boot warmup, not after it: with the fix installed,
    // every pipeline the warmup needs is already compiled asynchronously by the time the walk
    // starts, so a post-boot revert measures a window with no first draws in it at all.
    if (REVERT_ASYNC) {
      await page.addInitScript(`(() => {
        let undone = 0
        setInterval(() => {
          const p = window.__app && window.__app.renderer && window.__app.renderer._pipelines
          if (!p) return
          const proto = Object.getPrototypeOf(p)
          const d = proto ? Object.getOwnPropertyDescriptor(proto, 'getForRender') : null
          if (d && d.value && d.value.__spointAsyncRenderPipelines === true) {
            const orig = d.value.__spointOriginalGetForRender
            if (typeof orig === 'function') {
              Object.defineProperty(proto, 'getForRender', { value: orig, writable: true, configurable: true })
              undone++
            }
          }
        }, 4)
        window.__revertAsyncEarly = () => ({ undone })
      })()`)
    }
    await page.goto(`${base}/?singleplayer&dprOff=true`, { waitUntil: 'domcontentloaded' })
    const root = await assertServedClientRoot(page, { want: CLIENT_ROOT_BUNDLE, label: LABEL }).catch(e => e)
    if (root instanceof Error) fail(root.message)
    servedRoot = root
    const gpu = await witnessGpu(page, GPU_MODE)
    gpuName = gpu.renderer || gpu.adapter || null

    const t0 = Date.now()
    let playable = false
    while (Date.now() - t0 < TIMEOUT_MS) {
      const st = await page.evaluate(`({ playable: !!(${PLAYABLE_EXPR}) })`).catch(() => ({}))
      if (st.playable) { playable = true; break }
      await new Promise(r => setTimeout(r, 250))
    }
    if (!playable) fail(`the page never became playable within ${TIMEOUT_MS}ms (pageErrors=${pageErrors.length}${pageErrors[0] ? ': ' + pageErrors[0].slice(0, 200) : ''})`)

    // Pin the governor OFF for the measurement: a governor shed is a CONSEQUENCE of a hitch, and a
    // measuring arm that lets it react would damp the very stall this witness is locating.
    const pinned = await page.evaluate(`(() => {
      const rc = window.__renderControls
      if (!rc) return { error: 'no __renderControls' }
      const qg = rc.set('qualityGovernor', false)
      const dpr = rc.set('dprOff', true)
      return { qualityGovernor: { setReturned: qg, readback: rc.get('qualityGovernor') }, dprOff: { setReturned: dpr, readback: rc.get('dprOff') } }
    })()`)
    if (!pinned || pinned.error) fail(`could not pin the render controls: ${JSON.stringify(pinned)}`)
    expect('the measuring arm pins qualityGovernor off, so a governor shed cannot damp the stall', pinned.qualityGovernor.readback, '==', false)
    expect('the measuring arm pins dprOff on, so no pixel doubling is in play', pinned.dprOff.readback, '==', true)

    if (REVERT_ASYNC) {
      const reverted = await page.evaluate(`(() => {
        const st = window.__revertAsyncEarly ? window.__revertAsyncEarly() : null
        const p = window.__app && window.__app.renderer && window.__app.renderer._pipelines
        let wrapped = null
        if (p) {
          const proto = Object.getPrototypeOf(p)
          const d = proto ? Object.getOwnPropertyDescriptor(proto, 'getForRender') : null
          wrapped = !!(d && d.value && d.value.__spointAsyncRenderPipelines === true)
        }
        return { undone: st ? st.undone : 0, wrapped, requested: window.__asyncRenderPipelines ? window.__asyncRenderPipelines.requested : 0 }
      })()`)
      if (!reverted || reverted.wrapped !== false) fail(`--revert-async did not restore synchronous pipeline creation: ${JSON.stringify(reverted)}`)
      expect('the mutation is live before the walk: Pipelines.getForRender is no longer wrapped', reverted.wrapped, '==', false)
      expect('the early revert actually fired during boot, so the warmup compiled synchronously', reverted.undone, '>', 0)
      console.log(`[${LABEL}] --revert-async: synchronous createRenderPipeline restored ${reverted.undone} time(s) before the walk`)
    }

    await new Promise(r => setTimeout(r, SETTLE_MS))

    const installed = await page.evaluate(INSTALL_SRC)
    if (!installed || !installed.ok) fail(`the per-frame instrument never installed: ${JSON.stringify(installed)}`)
    expect('both frame graphs are exposed and profiling was turned on', installed.nodes, '>', 0)
    expect('the GPU work-unit hooks bound to their prototypes', Object.values(installed.gpuPatched).filter(Boolean).length, '>=', 8)
    expect('the compile-owner hook bound to three Pipelines.getForRender', installed.pipelineOwnerHook, '==', true)

    await page.evaluate(`window.__perf.reset()`)
    const start = await page.evaluate(PROBE)

    // Walk: the landscape has to actually change. Hold forward, and if the player stops making
    // ground, turn -- a standing player measures a different (and easier) frame than the report.
    const legs = ['KeyW', 'KeyW', 'KeyW', 'KeyD', 'KeyW', 'KeyA', 'KeyW', 'KeyD']
    let li = 0
    let held = null
    const track = []
    const tWalk = Date.now()
    let legAt = tWalk
    let lastPos = null
    while (Date.now() - tWalk < MEASURE_MS) {
      const code = legs[li % legs.length]
      if (code !== held) {
        if (held) await page.keyboard.up(held).catch(() => {})
        await page.keyboard.down(code).catch(() => {})
        held = code
        legAt = Date.now()
      }
      if (Date.now() - legAt >= LEG_MS) { li++; legAt = Date.now() }
      await new Promise(r => setTimeout(r, 500))
      const p = await page.evaluate(`(() => { const c = window.__client && window.__client.getLocalState ? window.__client.getLocalState() : null; return c && c.position ? [c.position[0], c.position[1], c.position[2]] : null })()`).catch(() => null)
      if (p) { track.push(p); lastPos = p }
    }
    if (held) await page.keyboard.up(held).catch(() => {})
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i]
      travelled += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    }
    const end = await page.evaluate(PROBE)
    report = await page.evaluate(REPORT_SRC)
    if (!report || report.error) fail(`the in-page report failed: ${JSON.stringify(report)}`)
    // A pipeline that never resolves is an object that never draws, so moving compilation off the
    // draw path is only safe if the async queue drains once the walk stops feeding it new scenery.
    await new Promise(r => setTimeout(r, 2500))
    const drained = await page.evaluate(`(() => { const s = window.__asyncRenderPipelines; return s ? { installed: s.installed, requested: s.requested, resolved: s.resolved, rejected: s.rejected, pending: s.pending } : null })()`).catch(() => null)
    console.log(`[${LABEL}] async pipelines after a 2.5s drain with no new scenery: ${jsonLine(drained)}`)

    const framesN = report.frames
    expect('the instrument counted frames', framesN, '>', 500)
    expect('the player actually travelled, so the landscape changed', travelled, '>', 30)
    expect('scene population is non-zero (veg instances counted)', end.veg, '>', 0)
    // A window in which nothing was compiled says NOTHING about the fix either way: the stall only
    // exists on a first draw, so a run with no first draws must fail rather than read as a pass.
    const compiled = (report.gpuTotal.createRenderPipeline || 0) + (report.gpuTotal.createShaderModule || 0) + ((end.asyncPipelines && end.asyncPipelines.requested) || 0)
    console.log(`[${LABEL}] first-draw compilation exercised by this window: ${compiled} pipeline/shaderModule unit(s) (floor ${MIN_COMPILES})`)
    expect('the window exercised first-draw compilation, so it can speak to the fix at all', compiled, '>=', MIN_COMPILES)
    expect('no uncaught page errors during the walk', pageErrors.length, '==', 0)

    console.log(`[${LABEL}] arm ${jsonLine({ gpu: gpuName, clientRoot: servedRoot ? clientRootTag(servedRoot) : null, viewport: VIEW_W + 'x' + VIEW_H, world: WORLD, measureMs: MEASURE_MS, nodeCount: installed.nodes })}`)
    console.log(`[${LABEL}] travel ${jsonLine({ travelledM: +travelled.toFixed(1), trackSamples: track.length, end: lastPos })}`)
    console.log(`[${LABEL}] wall(rAF delta) ${jsonLine(report.wall)}`)
    console.log(`[${LABEL}] cpu(main-thread frame cost) ${jsonLine(report.cpu)}`)
    console.log(`[${LABEL}] frames over ${HITCH_WALL_MS}ms wall: ${report.hitchFrames} of ${framesN} (${(100 * report.hitchFrames / Math.max(1, framesN)).toFixed(2)}%)`)
    console.log(`[${LABEL}] hitch attribution (dominant node inside every >=${HITCH_WALL_MS}ms frame):`)
    for (const h of report.hitchAttribution.slice(0, 12)) console.log(`    ${h.count}x  sum ${h.sumMs}ms  worst ${h.maxMs}ms  ${h.id}`)
    console.log(`[${LABEL}] gpu work units over the window: ${jsonLine(report.gpuTotal)}`)
    console.log(`[${LABEL}] worst single frame per node (top 25 of ${report.nodes.length}):`)
    for (const n of report.nodes.slice(0, 25)) {
      console.log(`    max ${String(n.maxFrameMs).padStart(9)}ms @frame ${String(n.maxAtFrame).padStart(6)}  p99 ${String(n.p99FrameMs).padStart(8)}ms  p50 ${String(n.p50FrameMs).padStart(8)}ms  over8ms ${String(n.framesOver).padStart(5)}  runs ${String(n.runs).padStart(7)}  total ${String(n.totalMs).padStart(9)}ms  ${n.id}`)
      console.log(`        that frame: wall ${n.maxFrameWallMs}ms cpu ${n.maxFrameCpuMs}ms runs ${n.maxFrameRuns} -- a node max whose own frame wall is not also long is an instrument artefact, not a stall`)
    }
    console.log(`[${LABEL}] worst ${report.worst.length} frames:`)
    for (const w of report.worst.slice(0, 15)) {
      console.log(`    frame ${w.frame} wall ${w.wallMs}ms cpu ${w.cpuMs}ms gpu ${JSON.stringify(w.gpu)}${w.long ? ` longtask ${JSON.stringify(w.long)}` : ''}`)
      console.log(`        pop ${JSON.stringify(w.pop)}`)
      for (const [id, ms, runs] of w.top) console.log(`        ${String(ms).padStart(9)}ms  x${runs}  ${id}`)
      for (const c of (w.creates || [])) console.log(`        create ${String(c.n).padStart(4)}x ${String(c.ms).padStart(8)}ms ${String(c.bytes).padStart(9)}B  ${c.call}`)
    }
    console.log(`[${LABEL}] worst ${report.worstCpu.length} frames by main-thread cpu (the ordering the wall distribution hides):`)
    for (const w of report.worstCpu.slice(0, 15)) {
      console.log(`    frame ${w.frame} cpu ${w.cpuMs}ms wall ${w.wallMs}ms gpu ${JSON.stringify(w.gpu)}${w.long ? ` longtask ${JSON.stringify(w.long)}` : ''}`)
      console.log(`        pop ${JSON.stringify(w.pop)}`)
      for (const [id, ms, runs] of w.top) console.log(`        ${String(ms).padStart(9)}ms  x${runs}  ${id}`)
      for (const c of (w.creates || [])) console.log(`        create ${String(c.n).padStart(4)}x ${String(c.ms).padStart(8)}ms ${String(c.bytes).padStart(9)}B  ${c.call}`)
    }
    console.log(`[${LABEL}] slowest single create call, by kind: ${report.gpuMaxMs.join(' ')}`)
    console.log(`[${LABEL}] async render pipelines ${jsonLine(end.asyncPipelines)}`)
    if (REQUIRE_ASYNC) {
      expect('the fix is installed: Pipelines.getForRender is wrapped for async pipeline creation', !!(end.asyncPipelines && end.asyncPipelines.installed), '==', true)
      expect('the fix did work: at least one render pipeline was created asynchronously', (end.asyncPipelines && end.asyncPipelines.requested) || 0, '>', 0)
      expect('no async pipeline is still pending after the drain, so nothing is left undrawn', drained ? drained.pending : -1, '==', 0)
      expect('no async pipeline was rejected', drained ? drained.rejected : -1, '==', 0)
    }
    console.log(`[${LABEL}] pipeline/shaderModule/texture call sites (whole window):`)
    for (const s of report.topProgramStacks) console.log(`    ${String(s.n).padStart(5)}x  ${s.call}`)
    console.log(`[${LABEL}] who paid a compile on its first draw (${report.ownerMaterialCount} distinct material id(s)):`)
    for (const s of report.topOwners) console.log(`    ${String(s.n).padStart(5)}x  ${s.call}`)
    if (report.mutation) console.log(`[${LABEL}] mutation ${jsonLine(report.mutation)}`)
    const failed = checks.filter(c => !c.pass)
    for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
    console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
    await browser.close().catch(() => {})
    browser = null
    server.stop()
    finish(failed.length === 0 ? 'PASS' : 'FAIL', failed.length === 0
      ? `frames=${framesN} wall p95=${report.wall.p95}ms p99=${report.wall.p99}ms max=${report.wall.max}ms; cpu p95=${report.cpu.p95}ms p99=${report.cpu.p99}ms max=${report.cpu.max}ms; ${report.hitchFrames} frames >=${HITCH_WALL_MS}ms; worst single-frame node ${report.nodes[0].id} ${report.nodes[0].maxFrameMs}ms; travelled ${travelled.toFixed(1)}m`
      : `${failed.length} check(s) failed`)
  } catch (e) {
    if (browser) await browser.close().catch(() => {})
    server.stop()
    throw e
  }
}

browserArm().catch(e => fail(`${e && e.stack ? e.stack : e}`))
