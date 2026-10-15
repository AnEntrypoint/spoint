#!/usr/bin/env node
// Shared capture server (PERF-grass-frame-harness-friction-1013): starts ONE long-lived server that
// serves the built client (client-root=bundle, hash-verified) with the DevHmr channel on, and records
// itself in .gm/capture-server.json. Captures attach with scripts/capture-attach.mjs.
// Refuses, never double-binds: an answering server recorded in the state file, or any foreign listener
// on the port, exits 3 with a named reason. Usage: node scripts/capture-server.mjs [--port=8790] [--world=tps-game]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_CAPTURE_PORT, SDK_ROOT, STATE_PATH, expectedBundle, portAccepts, probeServer, readState, removeState } from './lib/capture-server.mjs'
import { CLIENT_ROOT_BUNDLE, rebuildIfRequested } from './lib/served-client-root.mjs'

class Refusal extends Error {
  constructor(reason, detail) { super(detail); this.reason = reason }
}

async function main() {
  const argv = process.argv.slice(2)
  const arg = (n, d) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d }
  const PORT = Number(arg('port', DEFAULT_CAPTURE_PORT))
  const WORLD = arg('world', 'tps-game')

  const prior = readState()
  if (prior && !prior.corrupt) {
    const probe = await probeServer(prior.port)
    if (!probe.error) throw new Refusal('already-running', `pid ${prior.pid} answers on port ${prior.port}; attach to it instead of starting another`)
    removeState(STATE_PATH, prior.pid)
  }
  if (await portAccepts(PORT)) throw new Refusal('port-in-use', `port ${PORT} accepts connections but is not a capture server recorded in ${STATE_PATH}`)

  rebuildIfRequested('capture-server')
  const bundle = expectedBundle()
  if (!bundle.sha256) throw new Refusal('no-bundle', 'dist/client/app.js is absent; run npm run build:client or pass --rebuild-bundle')

  process.env.PORT = String(PORT)
  process.env.WORLD = process.env.WORLD || WORLD
  const { boot } = await import(pathToFileURL(resolve(SDK_ROOT, 'src', 'sdk', 'server.js')).href)
  const server = await boot()

  const probe = await probeServer(PORT, { timeoutMs: 120000 })
  if (probe.error || probe.status !== 200 || probe.kind !== CLIENT_ROOT_BUNDLE || probe.sha256 !== bundle.sha256) {
    try { server.stop() } catch {}
    throw new Refusal('served-root-mismatch', `after boot, GET /app.js gave status=${probe.status ?? probe.error} client-root=${probe.kind} sha=${String(probe.sha256).slice(0, 12)} expected ${bundle.sha256.slice(0, 12)}`)
  }

  mkdirSync(dirname(STATE_PATH), { recursive: true })
  const state = { pid: process.pid, port: PORT, world: process.env.WORLD, clientRoot: CLIENT_ROOT_BUNDLE, entrySha256: bundle.sha256, startedAt: new Date().toISOString(), hmr: !process.env.SPOINT_NO_WATCH }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  process.on('exit', () => removeState(STATE_PATH, process.pid))
  console.log(`RESULT: STARTED pid=${process.pid} port=${PORT} client-root=${CLIENT_ROOT_BUNDLE} sha=${bundle.sha256.slice(0, 12)} hmr=${state.hmr} state=${STATE_PATH}`)
}

try {
  await main()
} catch (e) {
  if (!(e instanceof Refusal)) throw e
  console.log(`RESULT: REFUSED reason=${e.reason} -- ${e.message}`)
  process.exitCode = 3
}
