const BLOCKED_PATTERNS = [
  'process.exit', 'child_process', 'require(', '__proto__',
  'Object.prototype', 'globalThis', 'eval(', 'import('
]

const FILE_CHANGE_DEBOUNCE_MS = 100

let _nm = null
async function _nodeModules() {
  if (_nm) return _nm
  const [fsp, fsSync, path, url] = await Promise.all([
    import('node:fs/promises'),
    import('node:fs'),
    import('node:path'),
    import('node:url')
  ])
  _nm = {
    readdir: fsp.readdir, readFile: fsp.readFile, watch: fsp.watch, access: fsp.access,
    existsSync: fsSync.existsSync, join: path.join, basename: path.basename,
    extname: path.extname, resolve: path.resolve, pathToFileURL: url.pathToFileURL
  }
  return _nm
}

export class AppLoader {
  constructor(runtime, config = {}) {
    this._runtime = runtime
    this._dirs = config.dirs || [config.dir || './apps']
    this._watchers = new Map()
    this._loaded = new Map()
    this._onReloadCallback = null
    this._onTreeChangeCallback = null
    this._reloadDebounceTimers = new Map()
  }

  async _resolvePath(name) {
    const { join, access } = await _nodeModules()
    for (const dir of this._dirs) {
      const flat = join(dir, `${name}.js`)
      try { await access(flat); return flat } catch {}
      const folder = join(dir, name, 'index.js')
      try { await access(folder); return folder } catch {}
    }
    return null
  }

  async loadAll() {
    const { readdir, access, join, basename, extname } = await _nodeModules()
    const seen = new Set()
    const loaded = [], failed = []
    for (const dir of this._dirs) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        let name = null
        if (entry.isFile() && entry.name.endsWith('.js')) {
          name = basename(entry.name, extname(entry.name))
        } else if (entry.isDirectory()) {
          try { await access(join(dir, entry.name, 'index.js')); name = entry.name } catch {}
        }
        if (name && !seen.has(name)) {
          seen.add(name)
          const ok = await this.loadApp(name)
          if (ok) loaded.push(name); else failed.push(name)
        }
      }
    }
    return { loaded, failed }
  }

  async loadApp(name) {
    const filePath = await this._resolvePath(name)
    if (!filePath) return null
    const { readFile } = await _nodeModules()
    try {
      const source = await readFile(filePath, 'utf-8')
      if (!this._validate(source, name)) return null
      const appDef = await this._evaluate(source, filePath)
      if (!appDef) return null
      this._runtime.registerApp(name, appDef)
      this._loaded.set(name, { filePath, source, clientCode: source })
      return appDef
    } catch (e) {
      console.error(`[AppLoader] failed to load "${name}": ${e.message}\n  file: ${filePath}\n  stack: ${e.stack?.split('\n').slice(1, 3).join('\n  ') || 'none'}`)
      return null
    }
  }

  _validate(source, name) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (source.includes(pattern)) {
        console.error(`[AppLoader] blocked pattern "${pattern}" in ${name}`)
        return false
      }
    }
    return true
  }

  async _evaluate(source, filePath) {
    const { resolve, pathToFileURL } = await _nodeModules()
    try {
      const absPath = resolve(filePath)
      const url = pathToFileURL(absPath).href + `?t=${Date.now()}`
      const mod = await import(url)
      return mod.default || mod
    } catch (e) {
      console.error(`[AppLoader] syntax/eval error in "${filePath}": ${e.message}\n  ${e.stack?.split('\n').slice(1, 3).join('\n  ') || ''}`)
      return null
    }
  }

  async watchAll() {
    const { existsSync, watch, join, basename, extname } = await _nodeModules()
    for (const dir of this._dirs) {
      if (!existsSync(dir)) {
        console.debug(`[AppLoader] skipping watch for missing directory: ${dir}`)
        continue
      }
      try {
        const ac = new AbortController()
        const watcher = watch(dir, { recursive: true, signal: ac.signal })
        this._watchers.set(dir, ac)
        ;(async () => {
          try {
            for await (const event of watcher) {
              if (!event.filename) continue
              if (this._onTreeChangeCallback) this._onTreeChangeCallback(event.filename)
              if (!event.filename.endsWith('.js')) continue
              const parts = event.filename.replace(/\\/g, '/').split('/')
              const name = parts.length > 1
                ? parts[0]
                : basename(event.filename, extname(event.filename))
              this._debounceFileChange(name)
            }
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.error(`[AppLoader] watch error:`, e.message)
            }
          }
        })()
      } catch (e) {
        console.error(`[AppLoader] watchAll error:`, e.message)
      }
    }
  }

  _debounceFileChange(name) {
    if (this._reloadDebounceTimers.has(name)) clearTimeout(this._reloadDebounceTimers.get(name))
    const timer = setTimeout(() => {
      this._reloadDebounceTimers.delete(name)
      this._onFileChange(name).catch(e => console.error(`[AppLoader] reload error for ${name}:`, e.message))
    }, FILE_CHANGE_DEBOUNCE_MS)
    this._reloadDebounceTimers.set(name, timer)
  }

  async _onFileChange(name) {
    console.log(`[AppLoader] reloading ${name}`)
    const appDef = await this.loadApp(name)
    if (appDef) {
      const cb = this._onReloadCallback ? (n, d) => {
        this._onReloadCallback(n, this._loaded.get(n)?.clientCode)
      } : null
      this._runtime.queueReload(name, appDef, cb)
      console.log(`[AppLoader] queued hot reload ${name}`)
    }
  }

  stopWatching() {
    for (const ac of this._watchers.values()) ac.abort()
    this._watchers.clear()
    for (const timer of this._reloadDebounceTimers.values()) clearTimeout(timer)
    this._reloadDebounceTimers.clear()
  }

  getLoaded() { return Array.from(this._loaded.keys()) }

  getClientModules() {
    const modules = {}
    for (const [name, data] of this._loaded) {
      if (data.clientCode) modules[name] = data.clientCode
    }
    return modules
  }

  getClientModule(name) { return this._loaded.get(name)?.clientCode || null }

  async loadFromString(name, source, deps = null) {
    if (!this._validate(source, name)) return null
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      console.error(`[AppLoader] loadFromString: URL.createObjectURL unavailable (edge target) -- use loadFromModule(name, module) instead`)
      return null
    }
    const revokes = []
    try {
      const rewrittenSource = deps ? this._rewriteDeps(source, deps, revokes) : source
      const blob = new Blob([rewrittenSource], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      revokes.push(url)
      const mod = await import(url)
      const appDef = mod.default || mod
      this._runtime.registerApp(name, appDef)
      this._loaded.set(name, { source, clientCode: source, filePath: null })
      return appDef
    } catch (e) {
      console.error(`[AppLoader] string eval error:`, e.message)
      return null
    } finally {
      for (const u of revokes) URL.revokeObjectURL(u)
    }
  }

  loadFromModule(name, appModule) {
    const appDef = appModule && appModule.default ? appModule.default : appModule
    if (!appDef || typeof appDef !== 'object') {
      console.error(`[AppLoader] loadFromModule: ${name} has no valid default export`)
      return null
    }
    this._runtime.registerApp(name, appDef)
    this._loaded.set(name, { source: null, clientCode: null, filePath: null })
    return appDef
  }

  _rewriteDeps(source, deps, revokes) {
    const urlMap = {}
    for (const [spec, entry] of Object.entries(deps)) {
      if (!entry) continue
      const sub = typeof entry === 'string' ? { source: entry, deps: {} } : entry
      const subSource = this._rewriteDeps(sub.source, sub.deps || {}, revokes)
      const blob = new Blob([subSource], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      revokes.push(url)
      urlMap[spec] = url
    }
    return source.replace(/((?:from|import)\s*)(['"])(\.[^'"]+|\/[^'"]+)\2/g, (m, pre, q, spec) =>
      urlMap[spec] ? `${pre}${q}${urlMap[spec]}${q}` : m
    )
  }

  async loadUntrustedApp(evaluator, name, source, deps = null) {
    if (!evaluator || typeof evaluator.evaluate !== 'function') {
      console.error(`[AppLoader] loadUntrustedApp: evaluator must have an evaluate() method`)
      return null
    }
    const sourceToEval = deps ? this._rewriteDeps(source, deps, []) : source
    const result = await evaluator.evaluate(sourceToEval, name)
    if (!result || !result.default) {
      console.error(`[AppLoader] sandbox evaluation failed for "${name}"`)
      return null
    }
    const appDef = result.default
    this._runtime.registerApp(name, appDef)
    this._loaded.set(name, { source, clientCode: source, filePath: null, untrusted: true })
    return appDef
  }
}
