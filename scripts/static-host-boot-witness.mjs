#!/usr/bin/env node
// ORCH-serverless-static-hosting-guard-1013. OWNER RULING, verbatim: "this is a serverless/self
// hosting game no cloud services, must be able to run everything that self hosted can do from the
// simple github pages setup polymorphically for rtc games as well as for singleplayer".
//
// This is the mechanical half of that ruling. It boots the shipped client from a PLAIN STATIC FILE
// SERVER -- node:http handing back raw bytes, no dev server, no bundler, no rebuild, no transform --
// and walks the real module graph the browser would walk, resolving every specifier the way the
// page's own import map tells it to. Three things fall out of that and all three are pinned:
//
//   1. STATIC-HOSTABILITY. Every module the boot needs answers 200 out of the static tree. A boot
//      that only the dev server can perform -- a specifier that needs a transform, a path that only
//      exists inside the bundler -- fails here instead of working in dev and 404ing on the host.
//
//   2. THE NO-CLOUD RULE, ENFORCED. Every remote URL the boot reaches must be one of the pinned
//      design CDN prefixes. Anything else -- a signalling relay, a STUN host, a telemetry collector,
//      a compute endpoint -- fails the boot by name. Remote URLs are classified, never fetched, so
//      this gate holds on a machine with no route to the internet.
//
//   3. POLYMORPHISM. Singleplayer (the in-page Worker server) and RTC multiplayer (the same server
//      wearing a peer session) have to be reachable from ONE static output: the same index.html, the
//      same import map, the same origin, in the same run. Two builds are not polymorphism.
//
// It is also the guard against the failure mode that has burned this repo twice. Browser arms used
// to load dist/client/app.js, a bundle that predated the source it was supposed to be built from, so
// they silently measured old code. This witness serves the CLIENT ENTRY STRAIGHT OUT OF THE SOURCE
// TREE, so there is no artifact to be stale: it prints the sha of what it served and, when a built
// artifact exists beside it, whether that artifact is older than the newest client source file.
// Measuring a stale bundle is not reachable from here.
//
// gpu-free: it reads bytes and resolves specifiers. No adapter, no browser, no pixel. Whether the
// frame that boot ends up drawing is the right frame is a browser arm CI does not run.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, extname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const LABEL = 'static-host-boot'
const say = (s) => console.log(`[${LABEL}] ${s}`)

const failures = []
function check(name, ok, detail) {
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures.push(name)
  return ok
}

// ---------------------------------------------------------------------------------------------
// The pinned design CDN. AGENTS.md: "design ships as pinned CDN URLs in
// client/{index,landing/index,editor/the-host}.html + scripts/bundle-client.mjs". Those four files
// are the allowlist's source of truth and these prefixes are what they actually name. A remote URL
// outside them is an out-of-bundle dependency and fails the boot.
// ---------------------------------------------------------------------------------------------
const PINNED_CDN_PREFIXES = [
  'https://unpkg.com/anentrypoint-design@',
  'https://cdn.jsdelivr.net/gh/AnEntrypoint/design@',
]
const isPinnedCdn = (url) => PINNED_CDN_PREFIXES.some((p) => url.startsWith(p))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}
const JS_MIME = /text\/javascript|application\/javascript|application\/json|application\/octet-stream/

// ---------------------------------------------------------------------------------------------
// A plain static file server. Raw bytes, correct content type, no transform of any kind. Two mount
// points because the shipped layout is dist-static's: the client tree sits at the root and the
// engine's src/, apps/ and node_modules/ sit beside it. Before an export exists the same layout is
// assembled from the source tree -- client/ at the root, the repo root providing the rest -- which
// is what `spoint static-export` would have written.
// ---------------------------------------------------------------------------------------------
// The committed tree, and only the committed tree. check.mjs scans `git ls-files --cached` and says
// The local git index is still worth reading, for the opposite reason: a file the boot serves that
// the index has never seen is a file CI's checkout may not have either, because publishing through
// the Git API leaves paths untracked locally. That is reported, not gated.
// node_modules is not tracked but is what `npm ci` installs, so it is not interesting here.
function trackedSet() {
  const out = new Set()
  try {
    const raw = execFileSync('git', ['ls-files', '-z', '--cached', '--', 'client', 'src', 'apps'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    for (const rel of raw.toString('utf8').split('\0')) if (rel) out.add(rel.replace(/\\/g, '/'))
  } catch { }
  return out
}

function buildMounts() {
  // --root points the guard at a specific static tree: a real `spoint static-export` output, or a
  // mutated copy a lane uses to prove the gate still fires. The repo root rides along behind it so a
  // partial tree resolves /src, /apps and /node_modules the way the export would carry them.
  const override = (process.argv.slice(2).find((a) => a.startsWith('--root=')) || '').slice(7)
  if (override) {
    return {
      label: `--root ${override} (repo root behind it)`,
      mounts: [
        { label: 'root-override', dir: resolve(override) },
        { label: 'root', dir: ROOT },
      ],
    }
  }
  const exported = join(ROOT, 'dist-static')
  if (existsSync(join(exported, 'index.html'))) {
    return { label: 'dist-static (the shipped export)', mounts: [{ label: 'dist-static', dir: exported }] }
  }
  return {
    // The worktree, because that is what `spoint static-export` copies and what a host is given.
    // The local git index is NOT the authority for what is on main: a lane that published through
    // the Git API leaves its paths untracked here while remote main has them. So untrackedness is
    // reported as a note below and never used to refuse a file.
    label: 'the worktree (client/ at the root, repo root beside it)',
    mounts: [
      { label: 'client', dir: join(ROOT, 'client'), key: (rel) => `client/${rel}` },
      { label: 'root', dir: ROOT, key: (rel) => rel },
    ],
  }
}

function startStaticServer(mounts, tracked) {
  let served = 0
  const untrackedServed = new Set()
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    const clean = posix.normalize(urlPath)
    if (clean.includes('..')) { res.writeHead(403).end('forbidden'); return }
    const rel = clean.replace(/^\/+/, '').split(/[\\/]/).join('/')
    for (const m of mounts) {
      const full = join(m.dir, rel)
      if (!full.startsWith(m.dir)) continue
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) continue
      served++
      // node_modules is installed by `npm ci`, so it is always untracked here and never interesting.
      if (m.key && !rel.startsWith('node_modules/') && !tracked.has(m.key(rel))) untrackedServed.add(clean)
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-store',
      })
      res.end(readFileSync(full))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  })
  return { server, servedCount: () => served, untrackedServed }
}

function listen(server) {
  return new Promise((ok, fail) => {
    server.listen(0, '127.0.0.1', () => ok(server.address().port))
    server.once('error', fail)
  })
}

// ---------------------------------------------------------------------------------------------
// Specifier extraction. Comments are stripped first so a URL sitting in a comment cannot fail a
// boot that never fetches it. Three forms: `import/export ... from 'x'`, bare `import 'x'`, and
// `import('x')` with a literal argument.
// ---------------------------------------------------------------------------------------------
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function specifiersOf(src) {
  const clean = stripComments(src)
  const out = []
  const fromRe = /(?:^|[\s;}])(?:import|export)\b[^;=]{0,400}?\bfrom\s*['"]([^'"]+)['"]/g
  const bareRe = /(?:^|[\s;}])(?:import|export)\s*['"]([^'"]+)['"]/g
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = fromRe.exec(clean)) !== null) out.push(m[1])
  while ((m = bareRe.exec(clean)) !== null) out.push(m[1])
  while ((m = dynRe.exec(clean)) !== null) out.push(m[1])
  return out
}

function parseImportMap(html) {
  const m = /<script\s+type="importmap"[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (!m) return null
  try { return JSON.parse(m[1]).imports || {} } catch { return null }
}

// The URLs the entry actually asks the network for: import-map VALUES (a key that looks like a URL
// is a remap, not a fetch), <script src>, <link href> for anything a browser loads, and the
// specifiers of any inline module script. <link rel=preconnect> is a hint about an origin, not a
// dependency, so it is reported beside the dependency set and never counted as one.
function entryDependencies(html, imports) {
  const remapped = new Set(Object.keys(imports).filter((k) => /^https?:\/\//.test(k)))
  const deps = new Set()
  const preconnect = new Set()
  const tagRe = /<(script|link)\b([^>]*)>/gi
  let t
  while ((t = tagRe.exec(html)) !== null) {
    const tag = t[1].toLowerCase()
    const attrs = {}
    let a
    const attrRe = /([\w-]+)\s*=\s*"([^"]*)"/g
    while ((a = attrRe.exec(t[2])) !== null) attrs[a[1].toLowerCase()] = a[2]
    const rel = (attrs.rel || '').toLowerCase()
    if (tag === 'link' && rel === 'preconnect') { if (attrs.href) preconnect.add(attrs.href); continue }
    const url = tag === 'link' ? attrs.href : attrs.src
    if (url && /^https?:\/\//.test(url)) deps.add(url)
  }
  for (const v of Object.values(imports)) if (/^https?:\/\//.test(v)) deps.add(v)
  // inline module scripts: their import specifiers are dependencies too
  const inlineRe = /<script\b[^>]*\btype="module"[^>]*>([\s\S]*?)<\/script>/gi
  let s
  while ((s = inlineRe.exec(html)) !== null) {
    for (const spec of specifiersOf(s[1])) if (/^https?:\/\//.test(spec)) deps.add(spec)
  }
  for (const r of remapped) deps.delete(r)
  return { deps: [...deps], preconnect: [...preconnect] }
}

// ---------------------------------------------------------------------------------------------
// Resolution, the way the browser does it: exact import-map key first, then the longest "x/" prefix
// key, otherwise URL-resolve against the importing module.
// ---------------------------------------------------------------------------------------------
function resolveSpecifier(spec, importerUrl, imports) {
  if (/^https?:\/\//.test(spec)) return { url: spec, kind: 'remote' }
  if (spec.startsWith('//')) return { url: new URL(spec, importerUrl).href, kind: 'remote' }
  if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) {
    return { url: new URL(spec, importerUrl).href, kind: 'same' }
  }
  if (spec.startsWith('node:')) return { url: null, kind: 'node-builtin' }
  if (Object.prototype.hasOwnProperty.call(imports, spec)) {
    const target = imports[spec]
    return { url: new URL(target, importerUrl).href, kind: /^https?:/.test(target) ? 'remote' : 'same' }
  }
  const prefixes = Object.keys(imports).filter((k) => k.endsWith('/')).sort((a, b) => b.length - a.length)
  for (const p of prefixes) {
    if (!spec.startsWith(p)) continue
    const target = imports[p] + spec.slice(p.length)
    return { url: new URL(target, importerUrl).href, kind: /^https?:/.test(target) ? 'remote' : 'same' }
  }
  return { url: null, kind: 'unmapped' }
}

function newestClientSourceMtime() {
  let newest = 0
  let name = ''
  const stack = [join(ROOT, 'client')]
  while (stack.length) {
    const d = stack.pop()
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of es) {
      if (e.name.startsWith('.')) continue
      const f = join(d, e.name)
      if (e.isDirectory()) { stack.push(f); continue }
      if (!/\.(js|mjs|html)$/.test(e.name)) continue
      try {
        const st = statSync(f)
        if (st.mtimeMs > newest) { newest = st.mtimeMs; name = f.slice(ROOT.length + 1).replace(/\\/g, '/') }
      } catch { }
    }
  }
  return { mtime: newest, name }
}

async function main() {
  const { label: rootLabel, mounts } = buildMounts()
  const { server, servedCount, untrackedServed } = startStaticServer(mounts, trackedSet())
  const port = await listen(server)
  const origin = `http://127.0.0.1:${port}`
  say(`static root: ${rootLabel}`)
  say(`plain file server on ${origin} -- raw bytes, no bundler, no dev server, no rebuild`)

  let pathsOk = 0
  let okModules = 0
  let remoteOffenders = new Set()

  try {
    // ---- the entry -----------------------------------------------------------------------------
    const entryRes = await fetch(`${origin}/index.html`)
    const entryHtml = await entryRes.text()
    check('the static server serves the entry index.html', entryRes.status === 200, `HTTP ${entryRes.status}`)
    if (entryRes.status !== 200) return

    const imports = parseImportMap(entryHtml)
    check('the entry carries a parseable import map', imports !== null, `${imports ? Object.keys(imports).length : 0} key(s)`)
    if (imports === null) return

    // ---- every remote URL the entry asks the network for has to be a pinned design CDN ----------
    const { deps, preconnect } = entryDependencies(entryHtml, imports)
    const offending = deps.filter((u) => !isPinnedCdn(u))
    const pinned = deps.filter(isPinnedCdn)
    check(
      'every remote URL the entry loads is a pinned design CDN URL',
      offending.length === 0,
      `${pinned.length} pinned, ${offending.length} other${offending.length ? `: ${offending.join(', ')}` : ''}`
    )
    check('the pinned set is not empty, so the allowlist is not a rubber stamp', pinned.length > 0, `${pinned.length} URL(s)`)
    if (preconnect.length) say(`note: ${preconnect.length} preconnect hint(s), not counted as dependencies: ${preconnect.join(', ')}`)

    // ---- walk the real boot graph ---------------------------------------------------------------
    // Only same-origin modules are fetched. Remote URLs are classified, never fetched, so this gate
    // does not depend on a route to the internet.
    const MAX_MODULES = 4000
    const seen = new Map()
    const queue = [new URL('/app.js', origin).href]
    const remoteOrigins = new Set()
    const notFound = []
    const unmapped = new Set()
    let bytes = 0
    let nodeBuiltins = 0

    while (queue.length > 0 && seen.size < MAX_MODULES) {
      const batch = queue.splice(0, 24)
      const results = await Promise.all(batch.map(async (url) => {
        try {
          const r = await fetch(url)
          const body = r.ok ? await r.text() : null
          return { url, status: r.status, body, type: r.headers.get('content-type') || '' }
        } catch (e) {
          return { url, status: -1, body: null, type: '', error: String((e && e.message) || e) }
        }
      }))
      for (const r of results) {
        if (seen.has(r.url)) continue
        seen.set(r.url, r.status)
        if (r.status !== 200) { notFound.push(`${new URL(r.url).pathname} (HTTP ${r.status})`); continue }
        if (!JS_MIME.test(r.type)) { notFound.push(`${new URL(r.url).pathname} (content-type ${r.type || 'none'})`); continue }
        bytes += (r.body || '').length
        for (const spec of specifiersOf(r.body || '')) {
          const res = resolveSpecifier(spec, r.url, imports)
          if (res.kind === 'node-builtin') { nodeBuiltins++; continue }
          if (res.kind === 'unmapped') { unmapped.add(spec); continue }
          if (res.kind === 'remote') {
            remoteOrigins.add(new URL(res.url).origin)
            if (!isPinnedCdn(res.url)) remoteOffenders.add(res.url)
            continue
          }
          if (!seen.has(res.url) && !queue.includes(res.url)) queue.push(res.url)
        }
      }
    }

    const localModules = [...seen.entries()].filter(([u]) => new URL(u).origin === origin)
    okModules = localModules.filter(([, s]) => s === 200).length
    say(`MEASURED ${LABEL}: ${okModules} module(s) resolved out of the static tree, ${(bytes / 1048576).toFixed(2)} MiB of source, ${remoteOrigins.size} remote origin(s), ${servedCount()} file(s) served`)

    check('the boot graph resolved at least one module out of the static tree', okModules > 0, `${okModules} module(s)`)
    check(
      'no module the boot needs is missing or mis-typed in the static tree',
      notFound.length === 0,
      notFound.length ? notFound.slice(0, 6).join('; ') : `${okModules} module(s) answered 200`
    )
    check(
      'no module the boot needs comes from a host outside the pinned CDN',
      remoteOffenders.size === 0,
      remoteOffenders.size ? [...remoteOffenders].slice(0, 6).join('; ') : `${remoteOrigins.size} remote origin(s), all pinned`
    )

    // ---- polymorphism: one static output, both boot paths ---------------------------------------
    // client/app.js:1527 -- client = (_isSingleplayer || _isHost || _joinOffer) ? new BrowserServer(...)
    // : new PhysicsNetworkClient(...). The RTC branches (app.js:1483, 1495, 2984) build a wireweave
    // bridge and hand it to the SAME BrowserServer as a peerSession, so an RTC session runs the same
    // in-page server a singleplayer session does. Both have to be reachable from this one root.
    const PATHS = [
      { url: '/BrowserServer.js', what: 'singleplayer: the in-page Worker server' },
      { url: '/WireweaveBridge.js', what: 'RTC: the wireweave bridge carrying the peer session' },
      { url: '/WireweaveJoinClient.js', what: 'RTC: the join path' },
      { url: '/HostMigration.js', what: 'RTC: host claim / migration over the same bridge' },
      // Not a static import anywhere: the boot hands its URL to `new Worker(...)` at runtime, so the
      // only thing a static host owes it is the bytes at that URL.
      { url: '/src/sdk/WorkerEntry.js', what: 'the Worker the singleplayer server runs in (identity from INIT.worldName)' },
    ]
    for (const p of PATHS) {
      const abs = new URL(p.url, origin).href
      let via = null
      if (seen.get(abs) === 200) via = 'import graph'
      else {
        try {
          const r = await fetch(abs)
          if (r.ok && JS_MIME.test(r.headers.get('content-type') || '')) via = 'served at its URL'
        } catch { }
      }
      const served = via !== null
      if (served) pathsOk++
      console.log(`  ${served ? '[PASS]' : '[FAIL]'} ${p.what} -- ${p.url}${served ? ` (${via})` : ' is NOT reachable from this static output'}`)
      if (!served) failures.push(p.what)
    }
    check(
      'singleplayer and RTC are both reachable from this one static output',
      pathsOk === PATHS.length,
      `${pathsOk}/${PATHS.length} path(s), one origin, one index.html, one import map`
    )

    // ---- the stale-artifact pin ------------------------------------------------------------------
    const entrySrc = join(mounts[0].dir, 'app.js')
    let servedSha = 'absent'
    try { servedSha = createHash('sha256').update(readFileSync(entrySrc)).digest('hex').slice(0, 12) } catch { }
    const artifact = join(ROOT, 'dist', 'client', 'app.js')
    if (existsSync(artifact)) {
      const aSha = createHash('sha256').update(readFileSync(artifact)).digest('hex').slice(0, 12)
      const { mtime, name } = newestClientSourceMtime()
      const stale = mtime > statSync(artifact).mtimeMs
      say(`MEASURED ${LABEL} artifact: served entry sha ${servedSha} from ${mounts[0].label}; built dist/client/app.js sha ${aSha} is ${stale ? 'STALE' : 'fresh'} against newest client source ${name || 'n/a'}`)
      say(`note: this boot served the SOURCE entry, so a stale artifact is not what was measured`)
    } else {
      say(`MEASURED ${LABEL} artifact: served entry sha ${servedSha} from ${mounts[0].label}; no built dist/client/app.js in this tree`)
    }

    if (untrackedServed.size > 0) say(`note: ${untrackedServed.size} served file(s) the local git index has never seen, so a fresh checkout may not have them: ${[...untrackedServed].slice(0, 8).join(', ')}`)
    if (unmapped.size > 0) say(`note: ${unmapped.size} bare specifier(s) the import map does not cover: ${[...unmapped].slice(0, 8).join(', ')}`)
    if (nodeBuiltins > 0) say(`note: ${nodeBuiltins} node: builtin import(s) skipped (never loaded by a browser)`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((done) => server.close(done))
  }

  const verdict = failures.length === 0
  console.log(`RESULT: ${verdict ? 'PASS' : 'FAIL'} -- ${okModules} module(s) of the shipped client boot from a plain static file server over ${servedCount()} file(s) with ${remoteOffenders.size} host(s) outside the pinned design CDN, ${pathsOk}/5 boot path(s) reachable from one static output, ${failures.length} failure(s)`)
  process.exit(verdict ? 0 : 1)
}

main().catch((e) => {
  console.error(`[${LABEL}] harness error: ${(e && e.stack) || e}`)
  process.exit(2)
})
