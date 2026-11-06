import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const run = root => spawnSync(process.execPath, [join(root, 'scripts/check-app-contract.mjs')], { cwd: root, encoding: 'utf8' })

const sandbox = mkdtempSync(join(tmpdir(), 'app-contract-negative-'))
try {
  for (const part of ['scripts', 'apps']) cpSync(join(repo, part), join(sandbox, part), { recursive: true })

  const intact = run(sandbox)
  assert.equal(intact.status, 0, `the unmodified tree must pass: ${intact.stderr}`)

  const libPath = join(sandbox, 'scripts/lib/app-contract.mjs')
  const lib = readFileSync(libPath, 'utf8')
  const flipped = lib.replace("['bad-render.js', ['app-contract-render-no-object']]", "['bad-render.js', []]")
  assert.notEqual(flipped, lib, 'the bad-render expectation must be present to flip it')
  writeFileSync(libPath, flipped)

  const broken = run(sandbox)
  assert.notEqual(broken.status, 0, 'a negative fixture that stops violating must fail the check')
  assert.match(broken.stderr, /fixture bad-render\.js: expected \[\], got \["app-contract-render-no-object"\]/)
  process.stdout.write('RESULT: PASS the app contract CLI passes the intact fixtures and exits non-zero when a negative fixture stops violating its rule\n')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}
