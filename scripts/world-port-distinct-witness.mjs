import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'

await installSpecifierHooks()

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'}${detail ? ` (${detail})` : ''}`)
}

const WORLDS = ['tps-game', 'tutorial', 'tutorial-rpg', 'construct', 'deathrun']
const ports = {}
for (const name of WORLDS) {
  const mod = await import(`../apps/world/${name}.js`)
  ports[name] = mod.default?.port
}

for (const name of WORLDS) {
  const port = ports[name]
  check(`${name} declares an integer port in the usable range`, Number.isInteger(port) && port >= 1024 && port <= 65535, String(port))
}

const byPort = new Map()
for (const name of WORLDS) {
  const list = byPort.get(ports[name]) ?? []
  list.push(name)
  byPort.set(ports[name], list)
}
const shared = [...byPort.entries()].filter(([, names]) => names.length > 1)
check('no two worlds declare the same port', shared.length === 0, shared.map(([port, names]) => `${port}: ${names.join(', ')}`).join('; ') || 'all distinct')

const index = await import('../apps/world/index.js')
check('the default world keeps port 3002, so a bare run is unchanged', index.default?.port === 3002 && ports['tps-game'] === 3002, `index=${index.default?.port} tps-game=${ports['tps-game']}`)

const failed = checks.filter((c) => !c.ok)
console.log(`${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length) {
  console.log(`RESULT: FAIL ${failed.length} check(s): ${failed.map((c) => c.name).join('; ')}`)
  await exitAfterQuiesce(1)
} else {
  console.log(`RESULT: PASS the five world definitions declare five distinct ports, and the default world keeps 3002 (${WORLDS.map((n) => `${n}=${ports[n]}`).join(', ')})`)
  await exitAfterQuiesce(0)
}
