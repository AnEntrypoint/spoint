#!/usr/bin/env node
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'scripts', 'patch-deps.mjs')
const HEADER = 'function patch(relPath, marker, anchor, replacement, label, strict) {'

const MARKERS = [
  'spoint patch] three r183',
  'spoint patch] instanceIndex decl guard: instanced_pars_vertex',
  'spoint patch] bindTextures',
  'spoint patch] BVH LOD hysteresis',
  't.deferUnreadyPrograms === true && !s.isReady()',
  '_this.deferUnreadyPrograms === true && program.isReady() === false',
  'const program = setProgram( camera, scene, geometry, material, object );\n\t\t\tif ( program === null ) return;',
  'if ( object.isInstancedMesh === true && object.count === 0 ) return;',
  'frustumCullingLOD(t, i, n, r, k = n.length)',
  'if (u === null && (u = l(c.box)), u !== null && u >= k) return;',
  'while (k > 1 && n[k - 1].object.visible === false) k--;',
  'value >>> 0 === value && !Object.is(value, -0)',
  'value >> 0 === value && !Object.is(value, -0)',
  'value >>> 0 === value && !Object.is(value, -0)',
  'value >> 0 === value && !Object.is(value, -0)',
  '\n\t\t\tdevice.popErrorScope().catch( () => null ).then( ( err ) => {',
  '\n\t\tdevice.popErrorScope().catch( () => null ).then( ( err ) => {',
  '\t\t\t\t\tconst errorScope = await device.popErrorScope().catch( () => null );',
]

const failures = []
const fail = (reason) => failures.push(reason)

async function loadCalls(text) {
  if (!text.includes(HEADER)) throw new Error('patch() header not found in scripts/patch-deps.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'patch-deps-marker-'))
  const file = join(dir, 'patch-deps.mjs')
  const body = text.replace(HEADER, 'function __patchOriginal(relPath, marker, anchor, replacement, label, strict) {')
  writeFileSync(file, 'const __calls = []\nfunction patch(...args) { __calls.push(args) }\n' + body + '\nexport { __calls }\n')
  const mod = await import(pathToFileURL(file).href)
  return mod.__calls.map(([relPath, marker, anchor, replacement, label, strict]) => ({ relPath, marker, anchor, replacement, label, strict: strict === true }))
}

function count(text, ch) {
  return text.split(ch).length - 1
}

const text = readFileSync(SOURCE, 'utf8')
const calls = await loadCalls(text)

const markers = calls.map((c) => c.marker)
if (markers.length !== MARKERS.length) fail(`marker count ${markers.length} != ${MARKERS.length}`)
for (let i = 0; i < Math.max(markers.length, MARKERS.length); i += 1) {
  if (markers[i] !== MARKERS[i]) fail(`marker ${i} is not byte-identical: got ${JSON.stringify(markers[i])}`)
}

for (const [i, c] of calls.entries()) {
  if (!c.replacement.includes(c.marker)) fail(`patch ${i} (${c.label}): marker is not in its payload, so a re-run would inject again`)
  if (c.replacement.includes('//')) fail(`patch ${i} (${c.label}): payload still carries a // comment`)
  for (const ch of ['{', '(', '[']) {
    const close = { '{': '}', '(': ')', '[': ']' }[ch]
    const a = count(c.anchor, ch) - count(c.anchor, close)
    const payload = c.replacement.replace(/const _\w+ = "spoint patch\][^"]*";/g, '')
    const r = count(payload, ch) - count(payload, close)
    if (a !== r) fail(`patch ${i} (${c.label}): ${ch}${close} balance changed from ${a} to ${r}`)
  }
}

const groups = new Map()
for (const c of calls) {
  if (!groups.has(c.relPath)) groups.set(c.relPath, [])
  groups.get(c.relPath).push(c)
}
for (const [relPath, group] of groups) {
  let src = group.map((c) => c.anchor).join('\n')
  for (const c of group) {
    if (src.includes(c.marker)) continue
    if (!src.includes(c.anchor)) {
      fail(`${relPath}: anchor for ${c.label} is not present when applied in order`)
      continue
    }
    src = src.replace(c.anchor, c.replacement)
  }
  for (const c of group) {
    if (!src.includes(c.marker)) fail(`${relPath}: after injection the marker for ${c.label} is missing, so a re-run would inject again`)
  }
}

if (failures.length > 0) {
  for (const f of failures) console.log('FAIL ' + f)
  console.log(`RESULT: FAIL ${failures.length} patch-deps payload check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`RESULT: PASS ${calls.length} patch markers are byte-identical to the pinned list, each marker is carried by its payload, no payload has a // comment, anchors keep their brace/paren/bracket balance, and each file's injection sequence leaves every marker present`)
}
