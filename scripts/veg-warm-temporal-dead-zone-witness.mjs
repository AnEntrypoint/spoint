#!/usr/bin/env node
// The tier-node-graph warm path in client/core/Vegetation.js is entered from ABOVE its own
// declarations: the species build loop reaches `queueTierNodeWarm(branch)` at a line that runs
// before control arrives at the warm helpers. Every binding that path reads must therefore already
// be initialized at that call site. A `const` (or `let`) declared below it is still in its temporal
// dead zone there, and the ReferenceError it throws is caught by the species build's own try/catch,
// which logged one `[veg] species build failed` per species and left the world with zero tree
// species -- no trees at all, no failed witness and nothing wrong at the draw level. A function
// declaration is initialized on scope entry, so it is safe from any call site.
//
// Counted work units only: each binding the warm path reads is classified as a hoisted declaration
// or as declared above the first call site, and one that is absent or still uninitialized there
// fails the run and names the line it is declared at.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'veg-warm-tdz'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REL = join('client', 'core', 'Vegetation.js')

// The bindings the warm path reads, from `queueTierNodeWarm` down to `awaitTierNodeWarm`.
const WARM_BINDINGS = [
  'pendingTierWarm', 'warmedTierMeshes', 'tierWarmPromises', 'warmCamera',
  'queueTierNodeWarm', 'warmOnceRetained', 'warmTierMeshes', 'warmTierMesh', 'awaitTierNodeWarm',
]
const CALL_RE = /\bqueueTierNodeWarm\s*\(\s*branch\s*\)/
const DECL_RE = /^\s*(const|let|var|async function|function)\s+([A-Za-z_$][\w$]*)\b/
const hoisted = (kind) => /function$/.test(kind || '')

let lines
try {
  lines = readFileSync(join(ROOT, REL), 'utf8').split(/\r?\n/)
} catch (e) {
  console.error(`[${LABEL}] RESULT: FAIL -- ${REL} is unreadable (${e.message}), so no warm binding was classified`)
  process.exit(1)
}

let callLine = -1
for (let i = 0; i < lines.length; i++) {
  if (CALL_RE.test(lines[i])) { callLine = i + 1; break }
}
if (callLine < 0) {
  console.error(`[${LABEL}] RESULT: FAIL -- no queueTierNodeWarm(branch) call site in ${REL}, so the species build loop no longer enters the warm path and this witness proves nothing`)
  process.exit(1)
}

const rows = WARM_BINDINGS.map((name) => {
  let declLine = -1
  let kind = null
  for (let i = 0; i < lines.length; i++) {
    const m = DECL_RE.exec(lines[i])
    if (m && m[2] === name) { declLine = i + 1; kind = m[1]; break }
  }
  return { name, declLine, kind }
})

const absent = rows.filter((r) => r.declLine < 0)
const late = rows.filter((r) => r.declLine > 0 && !hoisted(r.kind) && r.declLine >= callLine)
const above = rows.filter((r) => r.declLine > 0 && !hoisted(r.kind) && r.declLine < callLine)
const decls = rows.filter((r) => hoisted(r.kind))

for (const r of rows) {
  const why = r.declLine < 0
    ? 'ABSENT'
    : hoisted(r.kind)
      ? 'hoisted declaration'
      : r.declLine < callLine
        ? `declared above the call site (${callLine})`
        : `TEMPORAL DEAD ZONE: ${r.kind} at ${r.declLine}, reached from ${callLine}`
  console.log(`[${LABEL}] binding ${r.name}: ${r.kind || 'ABSENT'} at ${REL}:${r.declLine} -- ${why}`)
}

if (absent.length || late.length) {
  const why = [
    late.length ? `${late.length} still uninitialized at the call site (${late.map((r) => `${r.name} is ${r.kind} at ${r.declLine}`).join(', ')})` : '',
    absent.length ? `${absent.length} absent (${absent.map((r) => r.name).join(', ')})` : '',
  ].filter(Boolean).join(' and ')
  console.error(`[${LABEL}] RESULT: FAIL -- ${why}, so a species build that reaches the warm path throws before it can build a tree`)
  process.exit(1)
}

console.log(`[${LABEL}] RESULT: PASS -- ${rows.length} warm binding(s) initialized before the species build loop's warm call at ${REL}:${callLine}, ${decls.length} hoisted declaration(s) and ${above.length} declared above it`)
process.exit(0)
