#!/usr/bin/env node
import { createServer as createNetServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { parseArgs, numArg, strArg } from './lib/witness-args.mjs'

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const DEV = args.dev === true || args.dev === 'true'
if (!DEV) process.env.SPOINT_NO_WATCH = '1'
const WORLD = strArg(args.world, 'lockstep-rts')
const EXPECTED_PROFILE = strArg(args.profile, 'lockstep')
const HOLD_MS = numArg(args.holdMs, 0)
const URL_OUT = strArg(args.urlOut, '')
const PROFILE_WARNING_ID = 'netcode-profile-warning'

const freePort = () => new Promise((res, rej) => { const s = createNetServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const failures = []
const say = (...parts) => console.log(parts.join(' '))

const port = await freePort()
const tickRate = 60
const { createServer, buildStaticDirs } = await import('../src/sdk/server.js')
const APPS_DIRS = [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')]
const server = await createServer({ port, tickRate, appsDirs: APPS_DIRS, sdkRoot: SDK_ROOT, staticDirs: buildStaticDirs(SDK_ROOT, process.cwd(), APPS_DIRS), storageDir: resolve(process.cwd(), 'data') })
const worldDef = await (await import('../src/sdk/WorldLocator.js')).loadWorldModule(resolve(SDK_ROOT, 'apps/world', WORLD + '.js'))
await server.loadWorld({ ...worldDef, tickRate })
await server.start()

if (typeof globalThis.WebSocket !== 'function') {
  const { WebSocket } = await import('ws')
  globalThis.WebSocket = WebSocket
}
const { PhysicsNetworkClient } = await import('../src/client/PhysicsNetworkClient.js')

let sentWorldDef = null
const probe = new PhysicsNetworkClient({
  url: `ws://127.0.0.1:${port}/ws`,
  predictionEnabled: false,
  smoothInterpolation: false,
  webTransport: { enabled: false },
  onWorldDef: wd => { sentWorldDef = wd },
})
try { await probe.connect() } catch (e) { failures.push(`the probe client never connected to ws://127.0.0.1:${port}/ws (${e?.name}: ${e?.message})`) }

const deadline = Date.now() + 15000
while (Date.now() < deadline && !sentWorldDef) await sleep(100)

const wd = sentWorldDef
say(`  WORLD_DEF: name=${wd?.name ?? 'none'} netcode.profile=${wd?.netcode?.profile ?? 'none'} netcode.peers=${wd?.netcode?.peers ?? 'none'} entities=${Array.isArray(wd?.entities) ? wd.entities.length : 'stripped'}`)
if (!wd) failures.push(`the server sent no MSG.WORLD_DEF to a real client within 15 s, so nothing on the wire carries the declared profile`)
else {
  if (wd.name !== WORLD) failures.push(`WORLD_DEF carries name "${wd.name}", expected "${WORLD}"`)
  if ((wd.netcode?.profile ?? 'none') !== EXPECTED_PROFILE) failures.push(`WORLD_DEF carries netcode.profile "${wd.netcode?.profile ?? 'none'}", expected "${EXPECTED_PROFILE}"`)
  if (Array.isArray(wd.entities)) failures.push(`WORLD_DEF still carries ${wd.entities.length} entity/entities, so the join payload is not the stripped one`)
}

const pageUrl = `http://127.0.0.1:${port}/?connect=127.0.0.1:${port}&multiplayer=1`
say(`  remote page: ${pageUrl}`)
if (URL_OUT) writeFileSync(URL_OUT, pageUrl)

try { probe.stopInputLoop?.(); probe.disconnect?.() } catch (_) { }
if (HOLD_MS > 0) { say(`  holding the server ${HOLD_MS} ms for the browser arm`); await sleep(HOLD_MS) }
try { server.stop() } catch (_) { }
await sleep(300)

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`)
  console.log(`RESULT: FAIL (${failures.length} failure(s))`)
  process.exit(1)
}
console.log(`RESULT: PASS -- MSG.WORLD_DEF carries netcode.profile "${EXPECTED_PROFILE}" to a client that never saw the world file, so the remote arm can name the downgrade in #${PROFILE_WARNING_ID}`)
process.exit(0)
