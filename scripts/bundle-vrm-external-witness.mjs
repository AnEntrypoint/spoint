#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = '@pixiv/three-vrm'
const VRM_FILE = `node_modules/${PKG}/lib/three-vrm.module.js`
const INLINE_MARKER = 'THREE_VRM_THREE_REVISION'
const SIZE_LIMIT_BYTES = 1000000
const DIST_APP = 'dist/client/app.js'
const EXTERNAL_IMPORT_RE = /(?:from|import)\s*\(?\s*["']@pixiv\/three-vrm["']/
const expectInline = process.argv.slice(2).includes('--expect-inline')
const mode = expectInline ? 'expect-inline' : 'external'
const want = (direct, inverted) => (expectInline ? inverted : direct)

let total = 0
let failures = 0

function expect(name, ok, detail) {
  total++
  if (!ok) failures++
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function toRel(p) {
  return relative(ROOT, p).split(sep).join('/')
}

function parseImportmap(html) {
  const m = html.match(/<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    return { ok: true, imports: JSON.parse(m[1]).imports ?? {} }
  } catch (err) {
    return { ok: false, error: err.message, imports: {} }
  }
}

function resolveBare(imports, spec) {
  if (Object.hasOwn(imports, spec)) return imports[spec]
  let best = null
  for (const key of Object.keys(imports)) {
    if (key.endsWith('/') && spec.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  return best === null ? null : imports[best] + spec.slice(best.length)
}

function bareSpecifiers(src) {
  const specs = new Set()
  const patterns = [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.add(m[1])
  }
  return [...specs].filter(s => !/^(\.|\/|https?:|data:|node:|blob:)/.test(s)).sort()
}

const bundleClientSrc = readFileSync(join(ROOT, 'scripts/bundle-client.mjs'), 'utf8')
const pluginStart = bundleClientSrc.indexOf('const externalPlugin')
const pluginEnd = bundleClientSrc.indexOf('const outdir')
const pluginSrc = pluginStart >= 0 && pluginEnd > pluginStart ? bundleClientSrc.slice(pluginStart, pluginEnd) : ''
const externalFilterHits = pluginSrc.split('\n')
  .filter(line => /external:\s*true/.test(line))
  .filter(line => {
    const m = line.match(/filter:\s*\/((?:\\.|[^/\\\n])+)\/(?=\s*\})/)
    return m !== null && new RegExp(m[1]).test(PKG)
  })
expect('bundle-client-externalises-three-vrm', want(externalFilterHits.length > 0, externalFilterHits.length === 0), `externalPlugin filter lines matching ${PKG}: ${externalFilterHits.length}`)

const vrmPath = join(ROOT, VRM_FILE)
const vrmPresent = existsSync(vrmPath)
expect('three-vrm-file-present', vrmPresent, VRM_FILE)
const vrmSrc = vrmPresent ? readFileSync(vrmPath, 'utf8') : ''

const clientPages = walk(join(ROOT, 'client'))
  .filter(p => p.endsWith('.html'))
  .map(p => ({ rel: toRel(p), html: readFileSync(p, 'utf8') }))
const appPages = clientPages.filter(({ html }) => /<script[^>]+src="\/app\.js"|import\s*['"]\/app\.js['"]/.test(html) && /<script\s+type="importmap"/.test(html))
expect('client-app-pages-found', appPages.length > 0, appPages.map(p => p.rel).join(', ') || 'none')

for (const { rel, html } of appPages) {
  const map = parseImportmap(html)
  expect(`importmap-parses:${rel}`, map?.ok === true, map === null ? 'no importmap block' : map.ok ? 'JSON.parse ok' : map.error)
  const imports = map?.imports ?? {}
  const vrmTarget = imports[PKG]
  expect(`importmap-maps-three-vrm:${rel}`, typeof vrmTarget === 'string' && vrmTarget.startsWith('/node_modules/'), `target ${vrmTarget ?? '(absent)'}`)
  expect(`importmap-three-vrm-file-exists:${rel}`, typeof vrmTarget === 'string' && existsSync(join(ROOT, vrmTarget.slice(1))), `target ${vrmTarget ?? '(absent)'}`)
  for (const spec of bareSpecifiers(vrmSrc)) {
    const target = resolveBare(imports, spec)
    const resolved = typeof target === 'string' && target.startsWith('/') && existsSync(join(ROOT, target.slice(1)))
    expect(`three-vrm-bare-import-resolves:${spec}:${rel}`, resolved, `${spec} -> ${target ?? '(unmapped)'}`)
  }
}

const distPath = join(ROOT, DIST_APP)
if (!existsSync(distPath)) {
  expect('dist-app-inline-checks', true, `skipped: ${DIST_APP} is not built`)
} else {
  const app = readFileSync(distPath, 'utf8')
  const size = statSync(distPath).size
  const inlined = app.includes(INLINE_MARKER)
  const importsExternal = EXTERNAL_IMPORT_RE.test(app)
  expect('dist-app-inline-marker', want(!inlined, inlined), `${INLINE_MARKER} ${inlined ? 'present' : 'absent'} in ${DIST_APP} (mode ${mode})`)
  expect('dist-app-imports-three-vrm', want(importsExternal, !importsExternal), `bare import of ${PKG} ${importsExternal ? 'present' : 'absent'} in ${DIST_APP} (mode ${mode})`)
  expect('dist-app-size', want(size < SIZE_LIMIT_BYTES, size > SIZE_LIMIT_BYTES), `${DIST_APP} is ${size} bytes, limit ${SIZE_LIMIT_BYTES} (mode ${mode})`)
}

if (failures === 0) console.log(`RESULT: PASS ${total} checks (${mode})`)
else console.log(`RESULT: FAIL ${failures} of ${total} checks failed (${mode})`)
process.exit(failures === 0 ? 0 : 1)
