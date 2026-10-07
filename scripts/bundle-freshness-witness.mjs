#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const REQUIRE_BUNDLE = flags.has('--require-bundle')
const RUN_INPUT = flags.has('--stale-input')
const RUN_ARTIFACT = flags.has('--stale-artifact')

const BUNDLE_ARTIFACT = join(ROOT, 'dist', 'client', 'app.js')
const BUNDLE_STAMP = join(ROOT, 'dist', 'client', 'app.bundlehash.json')

const failures = []
function expect(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

const restorations = []
let restored = false
function restoreAll() {
  if (restored) return
  restored = true
  while (restorations.length) {
    const undo = restorations.pop()
    try { undo() } catch (e) { console.error(`[bundle-freshness-witness] restore failed: ${e && e.message || e}`) }
  }
}
process.on('exit', restoreAll)
process.on('SIGINT', () => { restoreAll(); process.exit(130) })
process.on('SIGTERM', () => { restoreAll(); process.exit(143) })

function replaceFile(path, bytes, { atime, mtime }) {
  const original = readFileSync(path)
  const before = statSync(path)
  const originalSha = sha256(original)
  restorations.push(() => {
    writeFileSync(path, original)
    utimesSync(path, before.atime, before.mtime)
    const afterSha = sha256(readFileSync(path))
    if (afterSha !== originalSha) throw new Error(`${path} did not restore (${originalSha} -> ${afterSha})`)
  })
  writeFileSync(path, bytes)
  utimesSync(path, atime, mtime)
  return originalSha
}

function stampInputs() {
  try {
    const stamp = JSON.parse(readFileSync(BUNDLE_STAMP, 'utf8'))
    return Array.isArray(stamp.inputs) ? stamp.inputs : []
  } catch {
    return []
  }
}

function pickClientInput() {
  const candidates = stampInputs()
    .filter(p => p.startsWith('client/'))
    .map(p => join(ROOT, p))
    .filter(p => existsSync(p) && statSync(p).isFile())
    .sort()
  return candidates.length ? candidates[candidates.length - 1] : null
}

const importUrl = rel => pathToFileURL(join(ROOT, rel)).href
const bootModule = await import(importUrl('src/sdk/ServerBoot.js'))
const { buildStaticDirs } = bootModule
const missingProbe = () => ({ fresh: null, reason: 'freshness-api-absent' })
const clientBundleFreshness = bootModule.clientBundleFreshness || missingProbe
const workerBundleFreshness = bootModule.workerBundleFreshness || missingProbe
const { createStaticHandler } = await import(importUrl('src/sdk/StaticHandler.js'))

async function serveOnce() {
  const started = Date.now()
  const dirs = buildStaticDirs(ROOT, ROOT, [])
  const dirsMs = Date.now() - started
  const handler = createStaticHandler(dirs)
  const server = createServer((req, res) => {
    handler(req, res).catch(e => { res.writeHead(500, { 'Cache-Control': 'no-store' }); res.end(String(e && e.message || e)) })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return {
    port,
    dirsMs,
    close: () => new Promise(r => server.close(r)),
  }
}

async function probe(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { 'accept-encoding': 'identity' } })
  const buf = Buffer.from(await res.arrayBuffer())
  const h = res.headers
  return {
    status: res.status,
    bytes: buf.length,
    sha: sha256(buf),
    root: h.get('x-spoint-client-root'),
    fresh: h.get('x-spoint-client-fresh'),
    reason: h.get('x-spoint-client-reason'),
    entrySha: h.get('x-spoint-entry-sha256'),
    workerRoot: h.get('x-spoint-worker-root'),
    workerFresh: h.get('x-spoint-worker-fresh'),
    workerReason: h.get('x-spoint-worker-reason'),
  }
}

const bundlePresent = existsSync(BUNDLE_ARTIFACT)
console.log(`[bundle-freshness-witness] sdkRoot=${ROOT}`)
console.log(`[bundle-freshness-witness] dist/client/app.js present=${bundlePresent}`)
const warmup = await serveOnce()
console.log(`[bundle-freshness-witness] buildStaticDirs + freshness cost: ${warmup.dirsMs}ms`)
await warmup.close()

const baseline = await serveOnce()
try {
  const observed = await probe(baseline.port, `/app.js?cb=${Date.now()}`)
  console.log(`[bundle-freshness-witness] GET /app.js -> ${JSON.stringify(observed)}`)
  expect('entry served', observed.status === 200, `status=${observed.status}`)
  expect('entry sha header matches body', observed.entrySha === observed.sha, `header=${observed.entrySha} body=${observed.sha}`)
  if (REQUIRE_BUNDLE) {
    expect('client root is the bundle', observed.root === 'bundle', `root=${observed.root} fresh=${observed.fresh} reason=${observed.reason}`)
    expect('worker root is the bundle', observed.workerRoot === 'bundle', `root=${observed.workerRoot} fresh=${observed.workerFresh} reason=${observed.workerReason}`)
  }
  expect('client bundle freshness is observable', observed.fresh === 'fresh' || observed.fresh === 'stale' || observed.fresh === 'no-bundle', `fresh=${observed.fresh}`)
  expect('worker bundle freshness is observable', observed.workerFresh === 'fresh' || observed.workerFresh === 'stale' || observed.workerFresh === 'no-bundle', `fresh=${observed.workerFresh}`)
  expect('a stale client bundle is never served', observed.fresh !== 'stale' || observed.root === 'raw-esm', `fresh=${observed.fresh} root=${observed.root}`)
  expect('a stale worker bundle is never served', observed.workerFresh !== 'stale' || observed.workerRoot === 'raw-esm', `fresh=${observed.workerFresh} root=${observed.workerRoot}`)
  if (observed.fresh === 'no-bundle') {
    expect('no-bundle reports raw-esm', observed.root === 'raw-esm', `root=${observed.root}`)
  }
} finally {
  await baseline.close()
}

if (RUN_INPUT) {
  const target = pickClientInput()
  if (!target) {
    expect('stale-input scenario has a client input to mutate', false, 'no configured client/ input found in app.bundlehash.json')
  } else {
    const original = readFileSync(target)
    const stat = statSync(target)
    replaceFile(target, Buffer.concat([original, Buffer.from('\nexport const __freshnessProbe = 1\n')]), { atime: stat.atime, mtime: stat.mtime })
    const mutated = await serveOnce()
    try {
      const observed = await probe(mutated.port, `/app.js?cb=${Date.now()}`)
      console.log(`[bundle-freshness-witness] stale-input ${target} -> ${JSON.stringify(observed)}`)
      expect('edited input with preserved mtime is detected as stale', observed.fresh === 'stale', `fresh=${observed.fresh} reason=${observed.reason}`)
      expect('stale client bundle is not served', observed.root === 'raw-esm', `root=${observed.root}`)
    } finally {
      await mutated.close()
      restoreAll()
      restored = false
    }
    const afterSha = sha256(readFileSync(target))
    expect('mutated input restored byte-for-byte', afterSha === sha256(original), `${target}`)
  }
}

if (RUN_ARTIFACT) {
  if (!bundlePresent) {
    expect('stale-artifact scenario has a bundle to replace', false, 'dist/client/app.js absent')
  } else {
    const original = readFileSync(BUNDLE_ARTIFACT)
    const now = new Date()
    replaceFile(BUNDLE_ARTIFACT, Buffer.concat([original, Buffer.from('\nexport const __freshnessProbe = 1\n')]), { atime: now, mtime: now })
    const mutated = await serveOnce()
    try {
      const observed = await probe(mutated.port, `/app.js?cb=${Date.now()}`)
      console.log(`[bundle-freshness-witness] stale-artifact -> ${JSON.stringify(observed)}`)
      expect('rebuilt-looking artifact that is not the stamped build is detected as stale', observed.fresh === 'stale', `fresh=${observed.fresh} reason=${observed.reason}`)
      expect('unmatched client bundle is not served', observed.root === 'raw-esm', `root=${observed.root}`)
    } finally {
      await mutated.close()
      restoreAll()
      restored = false
    }
    expect('bundle artifact restored byte-for-byte', sha256(readFileSync(BUNDLE_ARTIFACT)) === sha256(original))
  }
}

const finalClient = clientBundleFreshness(ROOT)
const finalWorker = workerBundleFreshness(ROOT)
console.log(`[bundle-freshness-witness] clientBundleFreshness=${JSON.stringify(finalClient)}`)
console.log(`[bundle-freshness-witness] workerBundleFreshness=${JSON.stringify(finalWorker)}`)

restoreAll()
if (failures.length) {
  console.log(`RESULT: FAIL (${failures.length}) :: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('RESULT: PASS')
