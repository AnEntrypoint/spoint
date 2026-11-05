import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')
const PASS = []
const FAIL = []
function expect(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

const ring = read('scripts/collider-ring-frame-cost-witness.mjs')
const sweep = read('scripts/veg-lod-sweep-witness.mjs')

const rmAt = ring.indexOf('await rm(WORK_DIR, { recursive: true, force: true })')
const mkAt = ring.indexOf("await mkdir(resolve(WORK_DIR, 'data'), { recursive: true })")
expect('collider-ring witness removes its fixed scratch dir before recreating it', rmAt > 0 && mkAt > rmAt, `rm at ${rmAt}, mkdir at ${mkAt}`)
expect('collider-ring witness imports rm from node:fs/promises', /import \{[^}]*\brm\b[^}]*\} from 'node:fs\/promises'/.test(ring))
expect('collider-ring witness scratch dir is the only fixed WORK_DIR', (ring.match(/const WORK_DIR = /g) || []).length === 1)
expect('veg-lod-sweep witness writes its json under a per-run label, not a fixed name', /const LABEL = flag\('label', 'veg-lod-sweep-' \+ Date\.now\(\)\)/.test(sweep))
expect('veg-lod-sweep witness counts work units alongside wall time', /recordsPerFrame/.test(sweep) && /planeTestsPerFrame/.test(sweep))

const ok = FAIL.length === 0
console.log(`checks: ${PASS.length} passed, ${FAIL.length} failed`)
console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`)
process.exit(ok ? 0 : 1)
