#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseCheckPins, missingCheckPins } from './lib/check-pin-gate.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const failures = []
const expect = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(label + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want))
}

const checkText = readFileSync(ROOT + 'scripts/check.mjs', 'utf8')
const pins = parseCheckPins(checkText)
for (const rel of ['scripts/check-relative-imports.mjs', 'scripts/check-cache-keys.mjs', 'scripts/check-tsl-imports.mjs', 'scripts/check-ses-preflight.mjs', 'scripts/check-app-contract.mjs', 'scripts/bundle-apps-manifest.mjs', 'scripts/gen-sdk-typings.mjs']) {
  if (!pins.includes(rel)) failures.push('check.mjs pin missing: ' + rel)
}
for (const rel of pins) if (!existsSync(ROOT + rel)) failures.push('pinned file absent from tree: ' + rel)
expect('legacy file: literal', parseCheckPins("file: 'a.mjs'"), ['scripts/a.mjs'])
expect('quoted scripts literal', parseCheckPins("run('scripts/x/y.js')"), ['scripts/x/y.js'])
expect('no pins', parseCheckPins('nothing here'), [])
expect('missing pin refused', missingCheckPins({ pins: ['scripts/q.mjs'], publishing: new Set(), remoteHas: () => false }), ['scripts/q.mjs'])
expect('remote pin accepted', missingCheckPins({ pins: ['scripts/q.mjs'], publishing: new Set(), remoteHas: () => true }), [])

if (failures.length > 0) {
  console.log('RESULT: FAIL ' + failures.join('; '))
  process.exitCode = 1
} else {
  console.log('RESULT: PASS check.mjs parses ' + pins.length + ' pinned scripts that all exist; legacy and quoted literals parse; a missing pin is refused and a remote pin is accepted')
}
