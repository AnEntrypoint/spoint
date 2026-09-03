const BLOCKED_PATTERNS = [
  'process.exit', 'child_process', 'require(', '__proto__',
  'Object.prototype', 'globalThis', 'eval(', 'import('
]

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
    // Fired on EVERY fs event under a watched dir (not just .js reloads) so a browser-fs-tree
    // client can refresh its listing when an agent creates/deletes/renames a file or folder.
    this._onTreeChangeCallback = null
    // server-scale-hotreload-migrate-function-tick-fenced: per-app-name trailing debounce for
    // _onFileChange, mirroring ReloadManager._debounce's own 100ms window (used for SDK/client
    // files). A single logical disk write commonly fires node:fs/promises `watch`'s recursive
    // mode MORE THAN ONCE for one save (live-witnessed on this Windows host: two 'change' events
    // for one write, and this is a documented cross-platform fs.watch quirk, not Windows-only) --
    // without debouncing, each event independently called queueReload(), so a single edit could
    // enqueue TWO reloads of the same app. Harmless before this row (a reload with no migrate()
    // is idempotent enough that firing twice just re-attaches the same def twice), but WITH a
    // migrate() export a double-fire is a real correctness bug: the second reload's migrate()
    // call would run against the ALREADY-migrated state and treat it as a fresh from-old-version
    // transition, live-reproduced during this row's own harness as stats.hits getting reset to 0
    // and reloads double-counted. Debouncing collapses a same-app double-fire into one reload.
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

  // failed = app names whose loadApp() returned null, for the caller to diff against expected apps and warn
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
    }, 100)
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
    // Edge fork: workerd does not implement URL.createObjectURL() -- a Blob+dynamic-import eval
    // cannot work on the Cloudflare Workers runtime. The edge target should use loadFromModule
    // (passing already-statically-imported module objects) instead of loadFromString.
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

  // Edge-compatible app loading: takes an already-statically-imported module object (no runtime
  // eval needed) and registers it directly. The edge target (Cloudflare Workers / workerd) can
  // statically import ES modules at deploy time but cannot use Blob + URL.createObjectURL +
  // dynamic import at runtime, so this is the correct path for edge-deployed apps.
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

  // Untrusted app loading: evaluates source through a sandbox evaluator that blocks
  // filesystem/network/process access and exposes only the safe ctx.* API surface.
  // Supports two tiers:
  //   - SESCompartmentEvaluator (preferred): full SES/Compartment hard-lockdown
  //   - SandboxEvaluator (fallback): proxy-based, for environments without SES
  // The evaluator's evaluate() may be sync (SandboxEvaluator) or async (SESCompartmentEvaluator).
  //
  // evaluator: SandboxEvaluator or SESCompartmentEvaluator instance (shared across all untrusted loads).
  // name: app name for registration.
  // source: the app source code (plain JS, must export a default app def).
  // deps: optional dependency map (same shape as loadFromString's deps).
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
