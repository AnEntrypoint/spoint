import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KW = ['fr', 'om'].join('')
const CASES = [
  {
    name: 'check-relative-imports',
    script: 'scripts/check-relative-imports.mjs',
    file: 'scripts/fail-path-fixture-relative.mjs',
    text: `import { missing } ${KW} './fail-path-fixture-does-not-exist.mjs'\nexport const value = missing\n`,
    tracked: true,
  },
  {
    name: 'check-cache-keys',
    script: 'scripts/check-cache-keys.mjs',
    file: 'src/static/fail-path-fixture.hf',
    text: 'not a heightfield\n',
    tracked: true,
  },
  {
    name: 'check-tsl-imports',
    script: 'scripts/check-tsl-imports.mjs',
    file: 'scripts/fail-path-fixture-tsl.mjs',
    text: `import { notAThreeExport } ${KW} 'three'\nexport const value = notAThreeExport\n`,
    tracked: false,
  },
]

const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
let failures = 0

for (const c of CASES) {
  const path = resolve(ROOT, c.file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, c.text)
  try {
    if (c.tracked) git(['add', '-N', '--', c.file])
    const run = spawnSync(process.execPath, [resolve(ROOT, c.script)], { cwd: ROOT, encoding: 'utf8' })
    const line = (run.stdout || '').split('\n').find((l) => l.startsWith('RESULT: FAIL'))
    const ok = run.status === 1 && line !== undefined
    if (!ok) failures += 1
    console.log(`${c.name}: exit ${run.status} ${ok ? 'ok' : 'NOT-FAIL'} ${line ?? '(no RESULT: FAIL line)'}`)
  } finally {
    if (c.tracked) git(['reset', '-q', '--', c.file])
    rmSync(path, { force: true })
  }
}

console.log(failures === 0 ? 'RESULT: PASS fail-path probe: each check exits 1 and prints RESULT: FAIL on its fixture' : `RESULT: FAIL fail-path probe: ${failures} check(s) did not fail as expected`)
process.exitCode = failures === 0 ? 0 : 1
