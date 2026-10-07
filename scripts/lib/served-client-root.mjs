import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLIENT_ROOT_HEADER = 'X-Spoint-Client-Root'
export const CLIENT_ENTRY_SHA_HEADER = 'X-Spoint-Entry-Sha256'
export const CLIENT_ENTRY_URL = '/app.js'
export const CLIENT_ROOT_BUNDLE = 'bundle'
export const CLIENT_ROOT_RAW = 'raw-esm'

const SDK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function clientRootCandidates(sdkRoot = SDK_ROOT) {
  const bundleEntry = join(sdkRoot, 'dist', 'client', 'app.js')
  const rawEntry = join(sdkRoot, 'client', 'app.js')
  return {
    [CLIENT_ROOT_BUNDLE]: existsSync(bundleEntry) ? bundleEntry : null,
    [CLIENT_ROOT_RAW]: existsSync(rawEntry) ? rawEntry : null,
  }
}

export function sha256OfFile(fp) {
  return createHash('sha256').update(readFileSync(fp)).digest('hex')
}

export function rebuildClientBundle(sdkRoot = SDK_ROOT) {
  execFileSync(process.execPath, [join(sdkRoot, 'scripts', 'bundle-client.mjs')], { cwd: sdkRoot, stdio: 'inherit' })
}

export function rebuildIfRequested(label) {
  if (!process.argv.includes('--rebuild-bundle')) return false
  console.log(`[${label}] --rebuild-bundle: running scripts/bundle-client.mjs before boot ...`)
  rebuildClientBundle()
  return true
}

async function readServedClientEntry(page, entryUrl) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { cache: 'no-store' })
    const bytes = (await res.arrayBuffer()).byteLength
    const loaded = performance
      .getEntriesByType('resource')
      .some(e => e.name.split('?')[0].endsWith(url))
    const probe = {
      status: res.status,
      kind: res.headers.get('X-Spoint-Client-Root'),
      sha256: res.headers.get('X-Spoint-Entry-Sha256'),
      bytes,
      loaded,
    }
    window.__spointServedClientRoot = { ...probe, entryUrl: url, origin: location.origin }
    return probe
  }, entryUrl)
}

export async function inspectServedClientRoot(page, opts = {}) {
  const { entryUrl = CLIENT_ENTRY_URL, sdkRoot = SDK_ROOT } = opts
  const served = await readServedClientEntry(page, entryUrl)
  const candidates = clientRootCandidates(sdkRoot)
  const hashes = {}
  let byHash = 'unknown'
  for (const kind of Object.keys(candidates)) {
    const fp = candidates[kind]
    if (!fp) continue
    hashes[kind] = sha256OfFile(fp)
    if (hashes[kind] === served.sha256) byHash = kind
  }
  return {
    entryUrl, ...served, byHash, hashes, candidates,
    bundlePath: join(sdkRoot, 'dist', 'client', 'app.js'),
  }
}

export function clientRootFailure(report, want) {
  const short = s => (s ? s.slice(0, 12) : 'none')
  if (report.status !== 200) {
    return `GET ${report.entryUrl} answered ${report.status} instead of 200 -- there is no client entry to attribute a code path to`
  }
  if (!report.kind) {
    return `GET ${report.entryUrl} carried no ${CLIENT_ROOT_HEADER} header -- this server build does not report which client root it served, so no witness may claim to have measured either path`
  }
  if (!report.sha256) {
    return `GET ${report.entryUrl} carried no ${CLIENT_ENTRY_SHA_HEADER} header -- the served bytes are unattributable, so the ${CLIENT_ROOT_HEADER} header alone cannot be trusted`
  }
  if (report.byHash === 'unknown') {
    return `GET ${report.entryUrl} served bytes hashing to ${short(report.sha256)} that match neither ${report.candidates[CLIENT_ROOT_BUNDLE] || 'dist/client/app.js (absent)'} nor ${report.candidates[CLIENT_ROOT_RAW]} -- the page ran bytes that are not this checkout's client entry`
  }
  if (report.kind !== report.byHash) {
    return `GET ${report.entryUrl} disagrees with itself: ${CLIENT_ROOT_HEADER} says ${report.kind} but the served bytes hash to the ${report.byHash} entry (${short(report.sha256)})`
  }
  if (want && report.kind !== want) {
    const why = want === CLIENT_ROOT_BUNDLE
      ? `${report.bundlePath} ${existsSync(report.bundlePath) ? 'is stale' : 'does not exist'}, so the server fell through to raw ESM; run \`npm run build:client\` and re-run, or pass --rebuild-bundle`
      : `the server served the prebuilt bundle but this arm is admitted only on raw ESM`
    return `this arm is admitted only on client-root=${want} but the server served client-root=${report.kind} (bytes ${short(report.sha256)}): ${why}`
  }
  return null
}

export function clientRootTag(report) {
  const short = s => (s ? s.slice(0, 12) : 'none')
  return `client-root=${report.kind} sha=${short(report.sha256)} bytes=${report.bytes} hash-verified=${report.byHash}${report.loaded ? '' : ' page-requested=false'}`
}

export async function assertServedClientRoot(page, opts = {}) {
  const { want = null, label = 'witness', entryUrl = CLIENT_ENTRY_URL, sdkRoot = SDK_ROOT } = opts
  const report = await inspectServedClientRoot(page, { entryUrl, sdkRoot })
  const failure = clientRootFailure(report, want)
  if (failure) {
    const err = new Error(`[${label}] ${failure}`)
    err.servedClientRoot = report
    throw err
  }
  return report
}
