import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let failures = 0
function expect(label, ok) {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label}`)
  if (!ok) failures += 1
}

const appContext = read('src/apps/AppContext.js')
const triggerVolume = read('src/stdlib-apps/trigger-volume/index.js')
const readme = read('src/behaviours/README.md')

expect('AppContext exposes getEntity for cross-entity access', /getEntity:\s*\(id\)\s*=>\s*runtime\.getEntity\(id\)/.test(appContext))
expect('AppContext exposes applyImpulse for the trap impulse', /applyImpulse:\s*\(entityId,\s*impulse,\s*worldPoint\)/.test(appContext))
expect('AppContext exposes the bus scope', /get bus\(\)\s*\{\s*return this\._busScope\s*\}/.test(appContext))
expect('trigger-volume emits its channel with targets', /bus\.emit\(channel,\s*\{[^}]*targets/.test(triggerVolume))
expect('trigger-volume gates re-fire with once and cooldownMs', /oneShot: !!cfg\.once/.test(triggerVolume) && /cooldownMs/.test(triggerVolume))
expect('behaviours README documents the plate pattern', readme.includes('## Plate pattern: trigger volume + cross-entity state write'))
expect('README names the impulse false-return rule', /`false` return means no body received/.test(readme))

if (failures > 0) {
  console.log(`RESULT: FAIL -- ${failures} check(s) failed`)
  process.exit(1)
}
console.log('RESULT: PASS')
