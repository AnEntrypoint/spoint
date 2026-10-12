// Witness-side server lifecycle: one registry, one exit path.
//
// A spoint server that is started and never stopped keeps the node event loop
// alive forever (measured: 358 active handles after `server.start()`, process
// still alive 20 s after main returned), so a witness that boots one and then
// merely falls off the end of main leaks a live process holding a port. Ten
// tracked witnesses boot a server and have no stop site; they survive only
// because they reach a `process.exit()`, which skips `stop()` entirely -- and
// `process.exit()` with handles mid-close is the uv_async_send assert case.
//
// The fix is this registry, not a try/finally per witness: register the server
// at the boot site (one line) and the process-exit hook stops it. Witnesses that
// route their exit through scripts/lib/quiesce.mjs get the stop before the
// handle drain, so they exit because the loop emptied rather than by force.
const tracked = []
let exitHookInstalled = false

function stopEntry(entry) {
  if (entry.stopped) return null
  entry.stopped = true
  if (typeof entry.server?.stop !== 'function') return null
  return entry.server.stop()
}

export function stopWitnessServersSync() {
  const result = { stopped: [], failed: [] }
  for (let i = tracked.length - 1; i >= 0; i--) {
    const entry = tracked[i]
    if (entry.stopped) continue
    try {
      stopEntry(entry)
      result.stopped.push(entry.label)
    } catch (error) {
      result.failed.push({ label: entry.label, message: error?.message || String(error) })
    }
  }
  return result
}

export async function stopWitnessServers() {
  const result = { stopped: [], failed: [] }
  for (let i = tracked.length - 1; i >= 0; i--) {
    const entry = tracked[i]
    if (entry.stopped) continue
    try {
      await stopEntry(entry)
      result.stopped.push(entry.label)
    } catch (error) {
      result.failed.push({ label: entry.label, message: error?.message || String(error) })
    }
  }
  return result
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => { stopWitnessServersSync() })
}

export function witnessServerCount() {
  return tracked.filter(e => !e.stopped).length
}

export function registerWitnessServer(server, label = 'server') {
  if (!server || typeof server !== 'object') return server
  installExitHook()
  tracked.push({ server, label, stopped: false })
  return server
}

export function registerWitnessDeps(deps, label = 'server-deps') {
  if (!deps || typeof deps !== 'object') return deps
  installExitHook()
  tracked.push({
    label,
    stopped: false,
    server: {
      stop() {
        deps.tickSystem?.stop?.()
        deps.reloadManager?.destroy?.()
        deps.connections?.destroy?.()
        deps.sessions?.destroyAll?.()
      }
    }
  })
  return deps
}
