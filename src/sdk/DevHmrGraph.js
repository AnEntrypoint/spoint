import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const IMPORT_RE = /(\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(['"])([^'"\n]+)\2/g
const ORIGIN = 'http://h'
const MODULE_EXT_RE = /\.m?js$/

export function readImportMap(htmlPath) {
  if (!existsSync(htmlPath)) return {}
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(readFileSync(htmlPath, 'utf8'))
  if (!m) return {}
  try { return JSON.parse(m[1]).imports || {} } catch { return {} }
}

function resolveBare(spec, importMap) {
  if (importMap[spec]) return importMap[spec]
  for (const key of Object.keys(importMap)) if (key.endsWith('/') && spec.startsWith(key)) return importMap[key] + spec.slice(key.length)
  return null
}

export function resolveSpecifier(spec, fromUrl, importMap) {
  const mapped = spec.startsWith('.') || spec.startsWith('/') ? spec : resolveBare(spec, importMap)
  if (!mapped || !mapped.startsWith('/') && !mapped.startsWith('.')) return null
  const u = new URL(mapped, ORIGIN + fromUrl)
  return u.origin === ORIGIN ? u.pathname : null
}

export function urlToFile(url, staticDirs) {
  for (const { prefix, dir } of staticDirs) {
    if (!url.startsWith(prefix)) continue
    const fp = join(dir, url.slice(prefix.length))
    const base = resolve(dir), abs = resolve(fp)
    if (abs !== base && !abs.startsWith(base + sep)) continue
    if (!existsSync(fp) || !statSync(fp).isFile()) continue
    let real
    try { real = realpathSync(fp) } catch { continue }
    const viaNodeModules = abs.includes(sep + 'node_modules' + sep)
    if (viaNodeModules || real === base || real.startsWith(base + sep)) return fp
  }
  return null
}

export function createModuleGraph({ staticDirs, importMap, roots }) {
  const deps = new Map(), eagerDeps = new Map(), parents = new Map(), fileToUrl = new Map(), versions = new Map()
  let effective = new Map()

  const link = (url, targets) => {
    for (const old of deps.get(url) || []) parents.get(old)?.delete(url)
    deps.set(url, targets)
    for (const t of targets) { if (!parents.has(t)) parents.set(t, new Set()); parents.get(t).add(url) }
  }

  const scan = (url) => {
    const fp = urlToFile(url, staticDirs)
    if (!fp) { link(url, new Set()); return [] }
    try { fileToUrl.set(realpathSync(fp), url) } catch {}
    const targets = new Set(), eagerTargets = new Set()
    const source = readFileSync(fp, 'utf8')
    for (const m of source.matchAll(IMPORT_RE)) {
      const target = resolveSpecifier(m[3], url, importMap)
      if (!target || !MODULE_EXT_RE.test(target)) continue
      targets.add(target)
      if (!m[1].includes('(')) eagerTargets.add(target)
    }
    eagerDeps.set(url, eagerTargets)
    link(url, targets)
    return [...targets]
  }

  const isEager = (root, url) => {
    const seen = new Set([root]), stack = [root]
    while (stack.length) {
      const u = stack.pop()
      if (u === url) return true
      for (const d of eagerDeps.get(u) || []) if (!seen.has(d)) { seen.add(d); stack.push(d) }
    }
    return false
  }

  const seed = (entries) => {
    for (const [url, v] of entries) if (deps.has(url) && Number.isFinite(v) && !versions.has(url)) versions.set(url, v)
    propagate()
  }

  const crawl = (start) => {
    const queue = [...start]
    while (queue.length) {
      const url = queue.pop()
      if (deps.has(url)) continue
      queue.push(...scan(url))
    }
  }

  const propagate = () => {
    effective = new Map()
    for (const [changed, v] of versions) {
      const queue = [changed], seen = new Set()
      while (queue.length) {
        const u = queue.pop()
        if (seen.has(u)) continue
        seen.add(u)
        if ((effective.get(u) || 0) < v) effective.set(u, v)
        queue.push(...(parents.get(u) || []))
      }
    }
  }

  const effectiveVersion = (url) => effective.get(url) || 0

  const ancestors = (url) => {
    const out = {}, queue = [url]
    while (queue.length) {
      const u = queue.pop()
      if (u in out) continue
      out[u] = [...(parents.get(u) || [])]
      queue.push(...out[u])
    }
    return out
  }

  const rewrite = (source, fromUrl) => source.replace(IMPORT_RE, (whole, pre, q, spec) => {
    const target = resolveSpecifier(spec, fromUrl, importMap)
    if (!target || !deps.has(target)) return whole
    const v = effectiveVersion(target)
    return v ? `${pre}${q}${target}?hmr=${v}${q}` : whole
  })

  const urlOfFile = (absPath) => {
    let real = absPath
    try { real = realpathSync(absPath) } catch {}
    return fileToUrl.get(real) || null
  }

  const markChanged = (url, stamp) => {
    versions.set(url, stamp)
    crawl(scan(url))
    propagate()
  }

  const forgetPatched = (url, stamp) => {
    if (versions.get(url) !== stamp) return false
    versions.delete(url)
    propagate()
    return true
  }

  crawl(roots)
  return { crawl, rewrite, ancestors, urlOfFile, markChanged, forgetPatched, seed, isEager, effectiveVersion, reaches: (root, url) => root in ancestors(url) || url === root, size: () => deps.size, parents }
}
