#!/usr/bin/env node
// `npx spoint static-export [outDir] [--base=/subpath]` (or `node node_modules/spoint/scripts/static-export.mjs`
// from a scaffolded create-spoint-game project) assembles a fully static, backend-less, singleplayer-only
// build of a spoint game -- the exact file set a static host (GitHub Pages, itch.io HTML5 upload, any plain
// CDN) needs to serve ?singleplayer&world=<name> with zero server process. This generalizes the logic proven
// live in .github/workflows/gh-pages.yml (spoint's own demo deploy) into a reusable tool any create-spoint-game
// project can run against ITS OWN apps/ -- the CI workflow stays as spoint's own demo-specific deploy (hardcoded
// to apps/maps/aim_sillos.glb etc), this script is the generic path for third-party projects.
//
// Two roots, same distinction server.js/src/sdk/server.js already draw: SDK_ROOT (this package -- client/,
// src/, bin/, node_modules/ -- resolved relative to THIS file, so it works whether spoint is the repo itself
// or an installed node_modules/spoint dependency) and PROJECT (process.cwd() -- the game's own apps/ + any
// project-root singleplayer-world.json override).
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = import.meta.dirname || dirname(fileURLToPath(import.meta.url))
const SDK_ROOT = join(__dirname, '..')
const PROJECT = process.cwd()

// Real dependency packages are NOT reliably at SDK_ROOT/node_modules/<pkg>: (a) inside a git worktree,
// node_modules is not checked out per-worktree at all -- it resolves via Node's normal upward walk to the
// actual repo root (confirmed live: this worktree has zero node_modules/ of its own, yet `npm run
// build:client`/`node server.js` both ran fine because Node's require/import algorithm walks parent dirs);
// (b) in a scaffolded create-spoint-game project, npm's normal hoisting can place spoint's own deps at the
// PROJECT's top-level node_modules/ instead of nested under node_modules/spoint/node_modules/. Resolve each
// package the same way Node itself would: walk upward from SDK_ROOT (and separately from PROJECT, for a
// scaffolded project's hoisted case) looking for a real node_modules/<pkg> directory, first hit wins.
function findPackageDir(pkg) {
  for (const startDir of [SDK_ROOT, PROJECT]) {
    let dir = startDir
    for (let i = 0; i < 12; i++) {
      const candidate = join(dir, 'node_modules', pkg)
      if (existsSync(candidate)) return candidate
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

// Transient build-cache/dev-only artifacts that must never ship in a static export -- .glb-cache/ is the
// server's own on-disk cache for the live GLB optimize/quantize pipeline (created lazily under apps/**),
// explicitly excluded from the published npm package too (package.json's own "files" list has
// "!**/.glb-cache/"), and *.test.js files are dev-only per this repo's no-test-files-in-production convention.
const EXCLUDE_RE = /(^|[\\/])\.glb-cache([\\/]|$)|\.test\.js$|(^|[\\/])\.git([\\/]|$)/
const cpFilter = (src) => !EXCLUDE_RE.test(src)

function parseArgs(argv) {
  const out = { outDir: 'dist-static', base: '' }
  for (const a of argv) {
    if (a.startsWith('--base=')) out.base = a.slice('--base='.length).replace(/\/$/, '')
    else if (!a.startsWith('--')) out.outDir = a
  }
  return out
}

function showHelp() {
  console.log(`
Usage: spoint static-export [outDir] [--base=/subpath]
       node scripts/static-export.mjs [outDir] [--base=/subpath]

Builds a fully static, singleplayer-only export of this spoint game into outDir (default
dist-static/) -- no server process needed at runtime, just any static file host. Use --base
when the host serves the site under a subpath (e.g. GitHub Pages project sites: --base=/my-repo).
Leave --base empty for itch.io (uploaded as a zip, served at its own root) or a custom domain.

Output is ready to zip for itch.io's HTML5 upload, or push directly as a GitHub Pages branch.
The exported page opens at index.html?singleplayer&world=<default world> automatically.
`)
}

function rel(p) { return relative(PROJECT, p) || '.' }

function log(msg) { console.log(`[static-export] ${msg}`) }

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) { showHelp(); process.exit(0) }
  const { outDir: outDirArg, base } = parseArgs(argv)
  const OUT = resolve(PROJECT, outDirArg)

  log(`SDK_ROOT=${SDK_ROOT}`)
  log(`PROJECT=${PROJECT}`)
  log(`OUT=${OUT}${base ? ` (base=${base})` : ''}`)

  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  mkdirSync(join(OUT, 'src'), { recursive: true })
  mkdirSync(join(OUT, 'node_modules'), { recursive: true })
  mkdirSync(join(OUT, 'apps'), { recursive: true })

  // 1. Build the minified client bundle (this repo's own scripts/bundle-client.mjs) straight into OUT root,
  //    same filename contract as the live dev server (buildStaticDirs / StaticHandler fallthrough) -- the
  //    exported index.html references /app.js unconditionally, so this MUST land at OUT/app.js, not dist/client/.
  log('building client bundle...')
  // Always build with an EMPTY base ('' -- never the real `base` value here): bundle-client.mjs's own
  // BASE-templated externals (xstate/msgpackr/streaming-gltf/etc, see its _bareToAbs map) would otherwise
  // self-prefix, and the uniform patchBase() pass below would then prefix them a SECOND time, producing a
  // real, live-caught double-prefix bug ('/my-game/my-game/node_modules/...'). One single patching pass
  // (patchBase, step 7) is the only place base-prefixing happens, applied uniformly to every output file.
  execFileSync(process.execPath, [join(SDK_ROOT, 'scripts/bundle-client.mjs'), join(SDK_ROOT, 'client/app.js'), join(OUT, 'app.js'), ''], { stdio: 'inherit', cwd: SDK_ROOT })

  // 2. Copy the app shell (everything else client/ serves at '/'): index.html, style.css, manifest.json,
  //    service-worker.js, favicon.svg, singleplayer-world.json fallback, and any client-only helper dirs
  //    referenced by relative import that bundle-client.mjs deliberately left external (core/ etc are
  //    already inlined into app.js -- only non-JS shell assets and the vendor/ dir need a raw copy).
  for (const f of ['index.html', 'style.css', 'manifest.json', 'service-worker.js', 'favicon.svg', 'singleplayer-world.json']) {
    const src = join(SDK_ROOT, 'client', f)
    if (existsSync(src)) cpSync(src, join(OUT, f))
  }
  if (existsSync(join(SDK_ROOT, 'client/vendor'))) cpSync(join(SDK_ROOT, 'client/vendor'), join(OUT, 'vendor'), { recursive: true, filter: cpFilter })

  // 3. Copy src/ (everything WorkerEntry.js's static import graph reaches server-side-shaped code from --
  //    physics/netcode/protocol/apps/stage/storage/transport/spatial/terrain/connection/debug/client, plus
  //    math.js/index.client.js) so BrowserServer's raw `new Worker(new URL('src/sdk/WorkerEntry.js', ...))`
  //    resolves every relative import to a real file, matching gh-pages.yml's own copy list exactly.
  const SRC_DIRS = ['client', 'protocol', 'shared', 'sdk', 'connection', 'debug', 'netcode', 'physics', 'apps', 'stage', 'storage', 'transport', 'spatial', 'terrain']
  for (const d of SRC_DIRS) {
    const s = join(SDK_ROOT, 'src', d)
    if (existsSync(s)) cpSync(s, join(OUT, 'src', d), { recursive: true, filter: cpFilter })
  }
  for (const f of ['math.js', 'index.client.js']) {
    const s = join(SDK_ROOT, 'src', f)
    if (existsSync(s)) cpSync(s, join(OUT, 'src', f))
  }

  // 4. Copy apps/ BEFORE bundling WorkerEntry (step 5 below): src/apps/AppContext.js imports
  //    `../../apps/_lib/*.js` (a repo/project-root-relative path, sibling of src/), so that graph must
  //    exist on disk before esbuild resolves it. Two source roots merge here: apps/_lib/* is ENGINE-owned
  //    (game-fsm.js, buffs.js, weapon.js, etc. -- lives only under SDK_ROOT/apps/_lib, a scaffolded
  //    create-spoint-game project never has its own copy, confirmed via bin/project-template/apps/ having
  //    only hello-app/+world/) while everything else under apps/ is the PROJECT's own game code. Copy the
  //    SDK's apps/_lib first, then overlay the project's apps/ on top (project apps/world, apps/hello-app
  //    etc. never collide with _lib/ by convention) -- falls back to the SDK's own bundled apps/ entirely
  //    only when the project genuinely has no apps/ dir at all (matches src/sdk/server.js's localApps ||
  //    sdkApps resolution, so the export boots the same world `npm start` would).
  const sdkLib = join(SDK_ROOT, 'apps/_lib')
  if (existsSync(sdkLib)) cpSync(sdkLib, join(OUT, 'apps/_lib'), { recursive: true, filter: cpFilter })
  const projApps = resolve(PROJECT, 'apps')
  const appsSrc = existsSync(projApps) ? projApps : join(SDK_ROOT, 'apps')
  cpSync(appsSrc, join(OUT, 'apps'), { recursive: true, filter: cpFilter })
  log(`apps/ copied from ${rel(appsSrc)}${existsSync(sdkLib) ? ' (+ engine apps/_lib)' : ''}`)

  // apps-fs-manifest.json: EditorFsBrowse's fs-browser tree needs a directory listing in a Worker (no real
  // fs) -- generate it from what was actually just copied, same approach as gh-pages.yml.
  const appFiles = []
  ;(function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      const relP = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(full, relP)
      else if (entry.name.endsWith('.js')) appFiles.push(relP)
    }
  })(join(OUT, 'apps'), '')
  writeFileSync(join(OUT, 'apps/apps-fs-manifest.json'), JSON.stringify({ files: appFiles.sort() }))

  // 5. Bundle WorkerEntry.js's SDK graph into one file and overwrite the raw copy IN PLACE at the exact path
  //    BrowserServer requests (src/sdk/WorkerEntry.js) -- mirrors gh-pages.yml's proven pattern exactly
  //    (bundle-after-patch would be a no-op since relative imports get absolutized first; bundle BEFORE any
  //    path patching, same ordering bug the workflow's own byte-size guard exists to catch). Must run AFTER
  //    step 4 (apps/ copy): AppContext.js's ../../apps/_lib/*.js imports resolve relative to OUT/src/apps/,
  //    landing on OUT/apps/_lib/ -- esbuild needs that on disk to inline it.
  log('bundling WorkerEntry module graph...')
  const workerBundleTmp = join(OUT, 'src/sdk/WorkerEntry.bundle.js')
  // Same empty-BASE reasoning as the bundle-client.mjs call above -- avoid a double-prefix from
  // bundle-worker.mjs's own BASE-templated externals (xstate/msgpackr/jolt-physics/wasm-compat) colliding
  // with the uniform patchBase() pass in step 7.
  execFileSync(process.execPath, [join(SDK_ROOT, 'scripts/bundle-worker.mjs'), join(OUT, 'src/sdk/WorkerEntry.js'), workerBundleTmp, ''], { stdio: 'inherit', cwd: SDK_ROOT })
  const bundledBytes = statSync(workerBundleTmp).size
  writeFileSync(join(OUT, 'src/sdk/WorkerEntry.js'), readFileSync(workerBundleTmp))
  rmSync(workerBundleTmp)
  // Same guard threshold as gh-pages.yml: a bundle that actually inlined the SDK graph is comfortably
  // >50KB; a near-empty output means the bundle step ran against already-patched (absolutized) imports
  // and produced a no-op passthrough instead -- fail loudly rather than ship a silently broken export.
  if (bundledBytes < 51200) {
    console.error(`[static-export] ERROR: WorkerEntry bundle is only ${bundledBytes} bytes (<50KB) -- the SDK graph did not inline. Aborting export.`)
    process.exit(1)
  }
  log(`WorkerEntry bundled -> ${bundledBytes} bytes`)

  // 6. Copy node_modules for every package the importmap (client/index.html) references by /node_modules/
  //    path, plus the bare-specifier bridges the WorkerEntry bundle's external plugin rewrites to the
  //    same absolute paths (xstate, msgpackr, jolt-physics/wasm-compat, d3-octree). List kept in lockstep
  //    with gh-pages.yml's own package list -- update both together if either changes.
  // NOTE: d3-octree is intentionally absent -- src/spatial/Octree.js's own header comment confirms it
  // was replaced by a flat uniform grid hash spatial index; gh-pages.yml still references it defensively
  // (a harmless no-op `if -d` guard) but it is not a real dependency of this codebase anymore.
  const PACKAGES = ['three', '@pixiv/three-vrm', 'webjsx', 'msgpackr', 'meshoptimizer', 'jolt-physics', 'xstate',
    '@dgreenheck/ez-tree', '@three.ez/instanced-mesh', 'bvh.js', 'mapspinner', 'streaming-gltf']
  let missingPkgs = []
  for (const pkg of PACKAGES) {
    const src = findPackageDir(pkg)
    if (!src) { missingPkgs.push(pkg); continue }
    const dest = join(OUT, 'node_modules', pkg)
    mkdirSync(dirname(dest), { recursive: true })
    // mapspinner/streaming-gltf may be workspace junctions/symlinks into packages/ -- dereference (cpSync
    // follows symlinks by default via fs.cp, matching gh-pages.yml's `cp -rL` for the identical reason).
    cpSync(src, dest, { recursive: true, dereference: true, filter: cpFilter })
  }
  if (missingPkgs.length) log(`WARNING: could not locate node_modules for: ${missingPkgs.join(', ')} -- export will 404 on these at runtime`)
  // Trim nested node_modules inside copied packages to keep the export small (same trim gh-pages.yml does).
  for (const nested of ['streaming-gltf/node_modules', 'mapspinner/node_modules']) {
    const p = join(OUT, 'node_modules', nested)
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }

  // 7. Base-path patching (only when --base is set -- itch.io/custom-domain hosts serve at root and need
  //    none of this). Mirrors gh-pages.yml's proven sed pass: absolute '/...' specifiers in every JS/HTML
  //    file need the base prefix, or every request 404s under a subpath host.
  if (base) {
    log(`patching absolute paths for base "${base}"...`)
    patchBase(OUT, base)
  }

  // 8. Bare-specifier rewrites (xstate/msgpackr/jolt-physics/wasm-compat) inside the bundled WorkerEntry.js
  //    were emitted as absolute /node_modules/... paths by bundle-worker.mjs's own external plugin (built
  //    with an empty BASE, step 5) -- patchBase's generic '/node_modules/' rule above already re-prefixes
  //    them correctly in the same uniform pass as everything else, no separate handling needed. Verified by
  //    the >50KB bundle-size guard (a broken bare specifier would throw at runtime import, not silently
  //    under-size the bundle, so that guard is a distinct live-load check, not redundant with this).

  // index.html itself already carries a `?singleplayer&world=<default>` auto-redirect for any bare visit
  // with no mode param (see client/index.html's inline pre-head script) -- its default world name is
  // project-specific (baked in at authoring time, not something this export step should guess at), so the
  // open hint below deliberately just points at index.html and lets that existing redirect do its job.
  log(`done -- static export at ${rel(OUT)}/`)
  log(`Open ${OUT}/index.html via any static file server (it auto-redirects to ?singleplayer&world=<default>), or zip ${rel(OUT)}/ for itch.io.`)
}

function patchBase(dir, base) {
  const files = []
  ;(function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|mjs|html|json)$/.test(entry.name)) files.push(full)
    }
  })(dir)
  for (const f of files) {
    let content = readFileSync(f, 'utf8')
    const before = content
    // Absolute root-relative specifiers -> base-prefixed, in ONE single pass per file so no rule can ever
    // re-match text a previous rule already rewrote (the real bug two prior attempts at this each hit:
    // running a "specific" string-literal pass THEN a "generic" href=/src= pass re-scanned the ALREADY-
    // prefixed output and matched again, e.g. `href="/node_modules/...` -> `href="/my-game/node_modules/
    // ...` [pass 1] -> `href="/my-game/my-game/node_modules/...` [pass 2, since `href="/` still literally
    // matched the now-prefixed text] -- live-caught in index.html's own modulepreload links). A SINGLE
    // combined regex with alternation, one .replace() call, sidesteps this entirely: each match is
    // consumed exactly once by construction, regardless of how many alternative branches could describe
    // it. `href="/`/`src="/` are HTML-attribute alternatives, included ONLY for .html files -- minified JS
    // property assignments (`o.src="/node_modules/..."`, from client/editor/EditPanelEditor.js's monaco
    // loader) contain that exact substring too (whitespace-stripped `.src = "` collapses to `.src="`), so
    // including those alternatives for .js/.mjs files would wrongly fire on JS property writes, not just
    // real HTML attributes -- also live-caught before this file-type gate was added.
    const htmlAttrAlt = /\.html$/.test(f) ? '|href="\\/|src="\\/' : ''
    const re = new RegExp(`(["'\`])\\/node_modules\\/|(["'\`])\\/src\\/|(["'\`])\\/apps\\/|(["'\`])\\/vendor\\/|(["'\`])\\/data\\/${htmlAttrAlt}`, 'g')
    content = content.replace(re, (m) => {
      if (m.startsWith('href="')) return `href="${base}/`
      if (m.startsWith('src="')) return `src="${base}/`
      // string-literal form: m is quoteChar + '/node_modules/' (or /src/, /apps/, /vendor/, /data/) --
      // reuse the matched quote char and the matched path segment verbatim, just insert base after it.
      const quote = m[0]
      const seg = m.slice(1)
      return `${quote}${base}${seg}`
    })
    if (content !== before) writeFileSync(f, content)
  }
}

main().catch(err => { console.error('[static-export] FAILED:', err); process.exit(1) })
