import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createServer as createSpointServer } from '../src/sdk/server.js'
import { loadWorldModule } from '../src/sdk/WorldLocator.js'

const SDK_ROOT = resolve(process.argv[2] || process.cwd())
const workDir = resolve(SDK_ROOT, 'data', 'boot-failure-witness')
await mkdir(resolve(workDir, 'data'), { recursive: true })
process.chdir(workDir)

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

const loaded = await loadWorldModule(resolve(SDK_ROOT, 'apps/world/tps-game.js'))
const worldDef = { ...loaded, entities: loaded.entities.filter(e => e.id !== 'env-sillos') }
const tickRate = worldDef.tickRate || 64
const port = await freePort()
const server = await createSpointServer({
  port, tickRate,
  appsDirs: [resolve(SDK_ROOT, 'apps'), resolve(SDK_ROOT, 'src/stdlib-apps')],
  sdkRoot: SDK_ROOT, gravity: worldDef.gravity, staticDirs: [],
  storageDir: resolve(workDir, 'data'),
})

let bootError = null
const realLog = console.log
let postLines = 0
try { await server.loadWorld({ ...worldDef, tickRate }) } catch (e) { bootError = e }
console.log = (...a) => { postLines++; realLog('POST-BOOT', ...a) }
for (let i = 0; i < 60; i++) await new Promise(r => setTimeout(r, 100))
console.log = realLog
console.log('RESULT postBootLogLines', postLines)
console.log('RESULT bootError:', bootError ? bootError.message : 'none')
if (!bootError) {
  await server.start()
  console.log('RESULT started on port', port)
}
try { server.stop() } catch (e) { console.log('RESULT stop threw', e?.message || e) }
const handles = process._getActiveHandles ? process._getActiveHandles() : []
const timers = handles.filter(h => h?.constructor?.name === 'Timeout' || h?._onTimeout)
console.log('RESULT activeHandles', handles.length, 'timers', timers.length, handles.map(h => h?.constructor?.name || typeof h).join(','))
process.exitCode = bootError ? 1 : 0
