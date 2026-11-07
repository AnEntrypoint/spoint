#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEAD = ['scripts/lib/hmr-specifier-loader.mjs', 'scripts/lib/src-specifier-resolver.mjs', 'scripts/lib/png-rgba.mjs']
const SELF = 'scripts/dead-lib-removal-witness.mjs'

function trackedReferences(name) {
  try {
    return execFileSync('git', ['grep', '-l', '-F', name, '--', ':!' + SELF], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

const problems = []
for (const file of DEAD) {
  if (existsSync(ROOT + file)) problems.push(file + ' still exists')
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.mjs$/, '')
  const refs = trackedReferences(base)
  if (refs.length > 0) problems.push(base + ' is still referenced by ' + refs.join(', '))
}
if (problems.length > 0) {
  console.log('RESULT: FAIL ' + problems.join('; '))
  process.exitCode = 1
} else {
  console.log('RESULT: PASS ' + DEAD.length + ' dead-code files are absent and no tracked file names them')
}
