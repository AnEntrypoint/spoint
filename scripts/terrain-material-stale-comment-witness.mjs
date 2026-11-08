#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tokenize } from './lib/js-token-stream.mjs'

const MODULE_REL = 'packages/mapspinner/src/tsl/terrain-material-tsl.js'
const MODULE_PATH = fileURLToPath(new URL('../' + MODULE_REL, import.meta.url))
const EXPECTED_EXPORTS = ['FD_TAPS', 'createTerrainMaterialTSL', 'makeHpfTexture', 'makeSurfaceTextures']

const text = readFileSync(MODULE_PATH, 'utf8')
const { comments } = tokenize(text)
const live = comments.filter((c) => c.kind !== 'hashbang')

console.log('file: ' + MODULE_REL)
console.log('comments outside strings and templates: ' + live.length)
for (const c of live) {
  const line = text.slice(0, c.start).split('\n').length
  console.log('  line ' + line + ' (' + c.kind + '): ' + c.text.split('\n')[0].slice(0, 100))
}

const mod = await import(MODULE_PATH)
const exported = Object.keys(mod).sort()
console.log('exports: ' + exported.join(', '))
console.log('expected exports: ' + EXPECTED_EXPORTS.join(', '))
const exportsOk = exported.length === EXPECTED_EXPORTS.length && EXPECTED_EXPORTS.every((name, i) => exported[i] === name)
const fdTapsOk = mod.FD_TAPS === 3

const pass = live.length === 0 && exportsOk && fdTapsOk
console.log('RESULT: ' + (pass ? 'PASS' : 'FAIL'))
process.exit(pass ? 0 : 1)
