#!/usr/bin/env node
import fs from 'node:fs'
import { join } from 'node:path'
import { chromium } from './lib/cdp-browser.mjs'
import { gpuLaunchArgs, gpuModeFlag, witnessGpu } from './lib/gpu-probe.mjs'
import { worldAppNames } from '../src/apps/appsManifest.js'
import { locateWorld, loadWorldModule } from '../src/sdk/WorldLocator.js'

const argv = process.argv.slice(2)
function flag(name, dflt = null) {
  const hit = argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}

const PORT = flag('port', '3139')
const WORLD = flag('world', 'tps-game')
const PARAMS = flag('params', 'singleplayer')
const TIMEOUT_MS = Number(flag('timeout', '360000'))
const EXPECT = flag('expect', 'hit')
const MAX_WALK = Number(flag('max-walk', '0'))
const MAX_PHASE_MS = Number(flag('max-phase-ms', '0'))
const REQUIRE_APP = flag('require-app', null)
const SETTLE_MS = Number(flag('settle', '1500'))
const NO_MANIFEST = argv.includes('--no-manifest')
const GPU_MODE = gpuModeFlag()
const ROOT = join(process.cwd())

const TAG = '[apps-manifest-fast-path]'
const failures = []
function expect(cond, msg) {
  if (cond) return
  failures.push(msg)
  console.error(`${TAG} assertion failed: ${msg}`)
}

const PROBE_PATCH = [
  'window.__fetchLog = [];',
  'window.__workerLog = { created: null, initAt: null, initApps: null };',
  'window.__fetchPatchInstalled = true;',
  '(() => {',
  '  const _fetch = window.fetch',
  '  window.fetch = function (input, init) {',
  '    const url = typeof input === "string" ? input : (input && input.url) ? input.url : String(input)',
  '    const rec = { url: url, t0: performance.now(), cache: (init && init.cache) || (input && input.cache) || null }',
  '    window.__fetchLog.push(rec)',
  '    return _fetch.call(window, input, init).then(',
  '      function (r) { rec.status = r.status; rec.t1 = performance.now(); rec.len = Number(r.headers && r.headers.get ? r.headers.get("content-length") : 0) || 0; return r },',
  '      function (e) { rec.status = "error"; rec.t1 = performance.now(); rec.len = 0; throw e }',
  '    )',
  '  }',
  '})();',
  '(() => {',
  '  const _Worker = window.Worker',
  '  window.Worker = function (url, opts) {',
  '    const w = new _Worker(url, opts)',
  '    if (window.__workerLog.created === null) window.__workerLog.created = performance.now()',
  '    const _post = w.postMessage.bind(w)',
  '    w.postMessage = function (msg, transfer) {',
  '      if (msg && msg.type === "INIT" && window.__workerLog.initAt === null) {',
  '        window.__workerLog.initAt = performance.now()',
  '        window.__workerLog.initApps = Array.isArray(msg.apps) ? msg.apps.map(a => a && a.name) : null',
  '      }',
  '      return _post(msg, transfer)',
  '    }',
  '    return w',
  '  }',
  '})();',
].join('\n')

const PROBE = `(() => {
  const log = window.__fetchLog || []
  const wl = window.__workerLog || {}
  const created = wl.created === undefined ? null : wl.created
  const initAt = wl.initAt === undefined ? null : wl.initAt
  const inWindow = e => (created === null || e.t0 >= created) && (initAt === null || e.t0 <= initAt)
  const res = log.filter(inWindow)
  const isManifest = u => /apps-manifest\\.json(\\?|$)/.test(u)
  const isAppSource = u => /\\/apps\\/.*\\.js(\\?|$)/.test(u)
  const isDepSource = u => /\\/(src|stdlib-apps)\\/.*\\.js(\\?|$)/.test(u)
  const manifest = res.filter(e => isManifest(e.url))
  const appWalk = res.filter(e => isAppSource(e.url))
  const depWalk = res.filter(e => isDepSource(e.url))
  const other = res.filter(e => !isManifest(e.url) && !isAppSource(e.url) && !isDepSource(e.url))
  const tracked = [...manifest, ...appWalk, ...depWalk]
  const start = tracked.length ? Math.min.apply(null, tracked.map(e => e.t0)) : null
  const end = tracked.length ? Math.max.apply(null, tracked.map(e => e.t1 === undefined ? e.t0 : e.t1)) : null
  const spanFromFetches = start === null ? null : Math.round((end - start) * 100) / 100
  const bytesFromFetches = tracked.reduce((a, e) => a + (e.len || 0), 0)
  const timing = new Map()
  for (const e of performance.getEntriesByType('resource')) if (!timing.has(e.name)) timing.set(e.name, e)
  const found = res.map(e => timing.get(e.url)).filter(Boolean)
  const spanStart = found.length ? Math.min.apply(null, found.map(e => e.startTime)) : null
  const spanEnd = found.length ? Math.max.apply(null, found.map(e => e.responseEnd)) : null
  const client = (window.__app && window.__app.client) || null
  return {
    resolutionSpanMs: spanFromFetches,
    resolutionBytes: bytesFromFetches,
    resourceTimingMatched: found.length,
    resourceSpanMs: spanStart === null ? null : Math.round((spanEnd - spanStart) * 100) / 100,
    patchInstalled: !!window.__fetchPatchInstalled,
    workerCreated: created,
    initAt: initAt,
    initAppCount: wl.initApps ? wl.initApps.length : null,
    resolutionFetches: res.length,
    manifestFetches: manifest.length,
    manifestStatus: manifest.map(e => e.status === undefined ? 'pending' : e.status),
    manifestCache: manifest.map(e => e.cache === undefined ? null : e.cache),
    manifestMs: manifest.length && manifest[0].t1 !== undefined ? Math.round((manifest[0].t1 - manifest[0].t0) * 100) / 100 : null,
    walkFetches: appWalk.length + depWalk.length,
    appWalkFetches: appWalk.length,
    depWalkFetches: depWalk.length,
    otherWindowFetches: other.length,
    walkUrls: appWalk.slice(0, 8).map(e => e.url.replace(/^https?:\\/\\/[^/]+/, '') + ' -> ' + (e.status === undefined ? 'pending' : e.status)),
    appResolutionMs: (start === null || end === null) ? null : Math.round((end - start) * 100) / 100,
    fetchTotal: log.length,
    playerId: client ? client.playerId : null,
    connected: !!(client && client.connected),
  }
})()`

const READY = `!!(window.__app && window.__app.client && window.__app.client.playerId != null && (window.__workerLog && window.__workerLog.initAt !== null))`

function manifestCandidates() {
  const roots = [join(ROOT, 'dist', 'client'), join(ROOT, 'client')]
  return [
    ...roots.map(r => join(r, 'apps-manifest.json')),
    ...roots.map(r => join(r, 'worlds', WORLD, 'apps-manifest.json')),
  ]
}

async function servedManifest(base) {
  const candidates = manifestCandidates()
  let status = null
  let bytes = null
  let appNames = null
  try {
    const r = await fetch(base + '/apps-manifest.json')
    status = r.status
    const text = await r.text()
    bytes = Buffer.byteLength(text)
    try { appNames = (JSON.parse(text).apps || []).map(a => a && a.name) } catch (_) { appNames = null }
  } catch (e) {
    status = 'fetch-failed: ' + e.message
  }
  const files = candidates.map(p => {
    try { return { path: p.replace(ROOT, '.'), bytes: fs.statSync(p).size } } catch (_) { return { path: p.replace(ROOT, '.'), bytes: null } }
  })
  return { status, bytes, appCount: appNames ? appNames.length : null, appNames, hasRequiredApp: REQUIRE_APP ? (appNames || []).includes(REQUIRE_APP) : null, matches: files.filter(f => f.bytes === bytes).map(f => f.path), files }
}

async function dropServedManifest() {
  const candidates = manifestCandidates()
  const removed = []
  for (const p of candidates) {
    for (const suffix of ['', '.br', '.gz', '.br.meta', '.gz.meta']) {
      const target = p + suffix
      const existed = fs.existsSync(target)
      try { fs.rmSync(target, { force: true }) } catch (_) { continue }
      if (existed) removed.push(target.replace(ROOT, '.'))
    }
  }
  return removed.map(p => p.replace(ROOT, '.'))
}

async function main() {
  process.env.SPOINT_SKIP_PREWARM = process.env.SPOINT_SKIP_PREWARM || '1'
  process.env.SPOINT_NO_WATCH = '1'
  process.env.WORLD = process.env.WORLD || WORLD
  process.env.PORT = PORT

  console.log(`${TAG} booting real server on port ${PORT} (world=${process.env.WORLD}) ...`)
  const { boot } = await import('../src/sdk/server.js')

  const { path: worldPath } = await locateWorld({ project: ROOT, sdkRoot: ROOT, name: WORLD })
  const worldDef = (await loadWorldModule(worldPath)) || {}
  const declaredApps = worldAppNames(worldDef)
  console.log(`${TAG} world ${WORLD} declares ${declaredApps.length} app(s): ${declaredApps.join(', ')}`)

  const server = await boot()
  const base = `http://localhost:${PORT}`
  const served = await servedManifest(base)
  console.log(`${TAG} served manifest: ${JSON.stringify(served)}`)
  const servedAppNames = Array.isArray(served.appNames) ? served.appNames : null
  const undeclared = servedAppNames ? servedAppNames.filter(n => !declaredApps.includes(n)) : null
  const missing = servedAppNames ? declaredApps.filter(n => !servedAppNames.includes(n)) : null
  console.log(`${TAG} served manifest scope: ${served.appCount} app(s) / ${served.bytes} bytes, world declares ${declaredApps.length}; undeclared=${JSON.stringify(undeclared)} missing=${JSON.stringify(missing)}`)
  expect(servedAppNames !== null, `the served apps-manifest is unparseable, so no scope claim is witnessed (status=${served.status} bytes=${served.bytes})`)
  expect(missing && missing.length === 0, `the served apps-manifest is missing ${missing ? missing.length : '?'} app(s) world "${WORLD}" declares: ${JSON.stringify(missing)} -- the browser falls back to /apps/<name>/index.js and drops them with a silent 404 at spawn`)
  expect(undeclared && undeclared.length === 0, `the served apps-manifest carries ${undeclared ? undeclared.length : '?'} app(s) world "${WORLD}" does not declare: ${JSON.stringify(undeclared)} -- the boot downloads sources it never resolves`)
  if (NO_MANIFEST) {
    const removed = await dropServedManifest()
    const afterDrop = await servedManifest(base)
    console.log(`${TAG} --no-manifest removed ${JSON.stringify(removed)}; server now reports ${JSON.stringify(afterDrop)}`)
    expect(afterDrop.status === 404, `--no-manifest did not take: the server still serves /apps-manifest.json with status ${afterDrop.status}, so this arm cannot witness the live walk`)
  }

  let browser = null
  try {
    browser = await chromium.launch({ headless: true, args: gpuLaunchArgs(GPU_MODE) })
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const pageErrors = []
    const consoleLines = []
    page.on('pageerror', e => pageErrors.push(String(e)))
    await page.enableDomain('Runtime.enable')
    page.on('Runtime.consoleAPICalled', p => {
      const t = (p?.args || []).map(a => a?.description || (a?.value === undefined ? '' : String(a.value))).join(' ')
      consoleLines.push(`${p?.type || 'log'}: ${t}`)
    })
    await page._send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_PATCH })
    const url = `${base}/?${PARAMS}${/(^|&)world=/.test(PARAMS) ? '' : `&world=${WORLD}`}`
    console.log(`${TAG} navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const gpu = await witnessGpu(page, GPU_MODE)
    console.log(`${TAG} rasterizer=${gpu.rasterizer} gpu=${gpu.haystack || 'none'} gpuMode=${GPU_MODE.mode}`)

    const t0 = Date.now()
    let ready = false
    let lastCount = -1
    let stableSince = Date.now()
    let lastHeartbeat = 0
    let probe = null
    while (Date.now() - t0 < TIMEOUT_MS) {
      ready = await page.evaluate(READY).catch(() => false)
      probe = await page.evaluate(PROBE).catch(() => null)
      const count = probe ? probe.fetchTotal : -1
      if (count !== lastCount) { lastCount = count; stableSince = Date.now() }
      if (Date.now() - lastHeartbeat > 15000) {
        lastHeartbeat = Date.now()
        console.log(`${TAG} heartbeat +${Math.round((Date.now() - t0) / 1000)}s ready=${ready} resolutionFetches=${probe ? probe.resolutionFetches : 'n/a'} manifest=${probe ? probe.manifestFetches : 'n/a'} walk=${probe ? probe.walkFetches : 'n/a'}`)
      }
      if (ready && Date.now() - stableSince >= SETTLE_MS) break
      await new Promise(r => setTimeout(r, 250))
    }

    probe = await page.evaluate(PROBE).catch(e => ({ error: 'evaluate failed: ' + e.message }))
    console.log(`${TAG} boot ready=${ready} pageErrors=${pageErrors.length}`)
    for (const e of pageErrors.slice(0, 5)) console.log(`${TAG}   [pageerror] ${e.slice(0, 200)}`)
    for (const c of consoleLines.slice(-8)) console.log(`${TAG}   [console] ${c.slice(0, 160)}`)
    console.log(`${TAG} probe ${JSON.stringify(probe)}`)

    expect(probe && probe.patchInstalled === true, `the probe never installed in the page, so the observation set is empty and witnesses nothing (probe=${JSON.stringify(probe)})`)
    expect(ready === true, `the page never finished app resolution and boot (worker INIT never observed): ${JSON.stringify(probe)}`)
    console.log(`${TAG} served manifest contains require-app ${REQUIRE_APP}: ${served.hasRequiredApp} (appCount=${served.appCount})`)
    if (REQUIRE_APP) expect(served.hasRequiredApp === true, `the manifest the server served does not contain the current app tree entry "${REQUIRE_APP}" (status=${served.status} appCount=${served.appCount}) -- the fast path would be serving stale app sources`)
    if (probe && probe.resolutionFetches !== undefined) {
      const hit = probe.manifestFetches >= 1 && probe.manifestStatus[0] === 200 && probe.walkFetches === 0
      console.log(`${TAG} path: ${hit ? 'MANIFEST-FAST-PATH' : 'LIVE-APP-WALK'} phase=${probe.resolutionSpanMs}ms bytes=${probe.resolutionBytes} fetches=${probe.resolutionFetches} manifest=${probe.manifestFetches}(${JSON.stringify(probe.manifestStatus)}, cache=${JSON.stringify(probe.manifestCache)}, ${probe.manifestMs}ms) walk=${probe.walkFetches} (apps=${probe.appWalkFetches} deps=${probe.depWalkFetches}) appsResolved=${probe.initAppCount} toInit=${probe.appResolutionMs}ms`)
      if (probe.walkFetches) console.log(`${TAG} walk urls: ${JSON.stringify(probe.walkUrls)}`)
      if (EXPECT === 'hit') {
        expect(probe.manifestFetches >= 1, `expected the manifest fast path but apps-manifest.json was never fetched (probe=${JSON.stringify(probe)})`)
        expect(probe.manifestStatus[0] === 200, `apps-manifest.json did not resolve 200: ${JSON.stringify(probe.manifestStatus)}`)
        expect(probe.walkFetches === 0, `expected zero live-walk fetches but the boot walked the app tree ${probe.walkFetches} time(s): ${JSON.stringify(probe.walkUrls)}`)
      } else if (EXPECT === 'miss') {
        expect(probe.walkFetches > 0, `expected the live app walk but the boot performed zero app-tree fetches (probe=${JSON.stringify(probe)})`)
      }
      if (MAX_WALK > 0) expect(probe.walkFetches <= MAX_WALK, `live-walk fetches ${probe.walkFetches} exceed --max-walk=${MAX_WALK}`)
      if (MAX_PHASE_MS > 0) expect(probe.resolutionSpanMs !== null && probe.resolutionSpanMs <= MAX_PHASE_MS, `app-resolution phase ${probe.resolutionSpanMs}ms exceeds --max-phase-ms=${MAX_PHASE_MS}`)
    }

    await browser.close().catch(() => {})
    server.stop()
    if (failures.length) {
      console.error(`${TAG} RESULT: FAIL -- ${failures[0]}`)
      process.exit(1)
    }
    console.log(`${TAG} RESULT: PASS -- path=${probe.manifestFetches >= 1 && probe.walkFetches === 0 ? 'manifest' : 'walk'} phase=${probe.resolutionSpanMs}ms bytes=${probe.resolutionBytes} fetches=${probe.resolutionFetches} manifest=${probe.manifestFetches}(${JSON.stringify(probe.manifestStatus)}) walk=${probe.walkFetches}`)
    process.exit(0)
  } catch (e) {
    console.error(`${TAG} run FAILED: ${e.stack || e.message}`)
    try { if (browser) await browser.close().catch(() => {}) } catch (_) {}
    try { server.stop() } catch (_) {}
    process.exit(1)
  }
}

main()
