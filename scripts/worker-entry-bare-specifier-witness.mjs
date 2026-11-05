import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import assert from 'node:assert/strict'

const ROOT = resolve(import.meta.dirname, '..')
const ENTRY = resolve(ROOT, 'src/sdk/WorkerEntry.js')
const STATIC_RE = /^\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"\n]+)['"]/gm

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function staticSpecifiers(text) {
  return [...stripComments(text).matchAll(STATIC_RE)].map(m => m[1])
}

assert.deepEqual(staticSpecifiers("import * as THREE from 'three'\n"), ['three'], 'the scanner must catch the bare specifier that broke the worker')

const seen = new Set()
const bare = []
const queue = [ENTRY]
while (queue.length) {
  const file = queue.pop()
  if (seen.has(file) || !existsSync(file)) continue
  seen.add(file)
  for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
    if (spec.startsWith('/') || spec.startsWith('node:')) continue
    if (spec.startsWith('.')) {
      const target = resolve(dirname(file), spec)
      for (const candidate of [target, target + '.js', target + '.mjs']) {
        if (existsSync(candidate)) { queue.push(candidate); break }
      }
      continue
    }
    bare.push(`${relative(ROOT, file)}: ${spec}`)
  }
}

assert.ok(seen.size > 20, `worker import closure too small to be real: ${seen.size} file(s)`)
assert.ok([...seen].some(f => f.endsWith('/src/animation/AnimationSystem.js')), 'the animation closure that used to import bare three is no longer reachable')
assert.deepEqual(bare, [], `module workers have no import map; these static bare specifiers cannot resolve:\n${bare.join('\n')}`)

console.log(`RESULT: PASS ${seen.size} worker-module file(s) resolve without a static bare import-map specifier`)
