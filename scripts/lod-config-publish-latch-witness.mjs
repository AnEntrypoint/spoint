#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { resolveLodConfig } = await import(pathToFileURL(resolve(ROOT, 'packages', 'mapspinner', 'src', 'lod-config.js')).href)

const FOVY = 70 * Math.PI / 180
globalThis.window = {}
const win = globalThis.window
const results = []
const expect = (name, got, want) => {
  const ok = Object.is(got, want)
  results.push(ok)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

console.log('[lod-config-publish-latch] window stub: plain object, module imported from packages/mapspinner/src/lod-config.js')

const first = resolveLodConfig({ maxLevel: 14, splitFactor: 0.87 }, FOVY)
expect('first call resolves its own maxLevel', first.maxLevel, 14)
expect('first call is not an operator override (maxLevel)', first.maxLevelOverridden, false)
expect('first call publishes its resolved maxLevel', win.__maxLevel, 14)

const second = resolveLodConfig({ maxLevel: 9, splitFactor: 0.87 }, FOVY)
expect('second call resolves its own maxLevel, not the first published 14', second.maxLevel, 9)
expect('second call does not read published maxLevel back as an override', second.maxLevelOverridden, false)
expect('second call does not read published splitFactor back as an override', second.splitFactorOverridden, false)
expect('second call republishes its own maxLevel', win.__maxLevel, 9)

win.__maxLevel = 6
const maxOp = resolveLodConfig({ maxLevel: 14, splitFactor: 0.87 }, FOVY)
expect('operator __maxLevel override takes effect', maxOp.maxLevel, 6)
expect('operator __maxLevel override is reported', maxOp.maxLevelOverridden, true)

win.__splitFactor = 0.5
const sfOp = resolveLodConfig({ maxLevel: 9, splitFactor: 0.87 }, FOVY)
expect('operator __splitFactor override takes effect', sfOp.splitFactor, 0.5)
expect('operator __splitFactor override is reported', sfOp.splitFactorOverridden, true)

const passed = results.every(Boolean)
console.log(`RESULT: ${passed ? 'PASS' : 'FAIL'} (${results.filter(Boolean).length}/${results.length} checks)`)
process.exit(passed ? 0 : 1)
