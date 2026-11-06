#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SOURCE_REL, GENERATED_REL, DIGEST_LINE, MAX_BUFFER,
  indexSource, recordedDigest, normalizeEol
} from './lib/appcontext-closure.mjs'
import { worktreeStateRev } from './lib/tree-under-test.mjs'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SOURCE = join(ROOT, 'src/apps/AppContext.js')
const HAND_MAINTAINED = join(ROOT, 'client/editor/sdk-typings.d.ts')
const GENERATED_OUT = join(ROOT, 'client/editor/sdk-typings.generated.d.ts')
const CTX_TYPES = join(ROOT, 'types/ctx.d.ts')
const TSC_BIN = join(ROOT, 'node_modules/typescript/bin/tsc')
const CHECK_ONLY = process.argv.includes('--check')
const PRE_COMMIT = process.argv.includes('--pre-commit')
const SNAPSHOT_DIR = join(ROOT, '.gm', 'tmp', 'sdk-typings-staged')

function git(...args) {
  const env = { ...process.env }
  delete env.GIT_INDEX_FILE
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: MAX_BUFFER })
}

function gitIndex(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

function discardStagedSnapshot() {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
  try { git('worktree', 'prune') } catch { }
}

async function materializeStagedSnapshot(index) {
  discardStagedSnapshot()
  const rev = worktreeStateRev(ROOT) ?? 'HEAD'
  try {
    git('worktree', 'add', '--detach', SNAPSHOT_DIR, rev)
  } catch (e) {
    if (rev === 'HEAD') throw e
    git('worktree', 'add', '--detach', SNAPSHOT_DIR, 'HEAD')
  }
  symlinkSync(join(ROOT, 'node_modules'), join(SNAPSHOT_DIR, 'node_modules'), 'junction')
  const staged = new Set(stagedPaths())
  for (const rel of await index.members()) {
    if (!staged.has(rel)) continue
    const target = join(SNAPSHOT_DIR, rel)
    let content
    try {
      content = gitIndex('show', ':' + rel)
    } catch {
      rmSync(target, { force: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return join(SNAPSHOT_DIR, SOURCE_REL)
}

function findEmittedDeclaration(root, fileName) {
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === fileName) return full
    }
  }
  return null
}

function stagedPaths() {
  return gitIndex('diff', '--cached', '--name-only').split('\n').map(s => s.trim()).filter(Boolean)
}

function stagedContent(rel) {
  return gitIndex('show', ':' + rel)
}

function refuse(lines) {
  for (const line of lines) console.error('[gen-sdk-typings] ' + line)
  process.exit(1)
}

async function checkStagedClosure() {
  const staged = stagedPaths()
  if (staged.length === 0) return
  const index = indexSource(ROOT)
  const members = await index.members()
  const touched = staged.filter(p => members.includes(p))
  if (touched.length === 0) return
  const digest = await index.digest()

  if (!staged.includes(GENERATED_REL)) {
    refuse([
      `REFUSING COMMIT: ${touched.join(', ')} is part of the ${SOURCE_REL} import closure,`,
      `but ${GENERATED_REL} is not part of this commit.`,
      `fix: npm run gen-typings && git add ${GENERATED_REL}`
    ])
  }

  const recorded = recordedDigest(stagedContent(GENERATED_REL))
  if (recorded === null) {
    refuse([
      `REFUSING COMMIT: ${GENERATED_REL} carries no source digest. it predates this check or was hand-edited.`,
      `fix: npm run gen-typings && git add ${GENERATED_REL}`
    ])
  }
  if (recorded !== digest) {
    refuse([
      `REFUSING COMMIT: ${GENERATED_REL} was generated from source digest ${recorded.slice(0, 12)},`,
      `but this commit's ${SOURCE_REL} import closure digests to ${digest.slice(0, 12)}.`,
      `the committed artifact would not match the committed source, so the CI drift step would fail.`,
      `fix: git add ${touched.join(' ')} && npm run gen-typings && git add ${GENERATED_REL}`
    ])
  }
  console.log(`[gen-sdk-typings] ${GENERATED_REL} matches the staged ${SOURCE_REL} import closure (${digest.slice(0, 12)}, ${members.length} files)`)
}

function extractMemberNames(dtsText) {
  const names = new Set()
  const re = /^\s*(?:get |set )?(readonly )?([A-Za-z_$][\w$]*)\s*[(:?]/gm
  let m
  while ((m = re.exec(dtsText))) {
    const name = m[2]
    if (['interface', 'declare', 'class', 'export', 'import', 'const', 'type'].includes(name)) continue
    names.add(name)
  }
  return names
}

function countsOf(lines) {
  const counts = new Map()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}

function sameLineMultiset(a, b) {
  if (a.length !== b.length) return false
  const ca = countsOf(a)
  const cb = countsOf(b)
  if (ca.size !== cb.size) return false
  for (const [line, n] of ca) if (cb.get(line) !== n) return false
  return true
}

function linesOnlyIn(from, other) {
  const counts = countsOf(from)
  for (const line of other) {
    const n = counts.get(line) ?? 0
    if (n <= 1) counts.delete(line)
    else counts.set(line, n - 1)
  }
  return [...counts.keys()]
}

function physicsNonNegSinks(ctxText) {
  const start = ctxText.indexOf('export interface PhysicsAPI {')
  if (start < 0) throw new Error(`[gen-sdk-typings] ${CTX_TYPES} declares no PhysicsAPI interface`)
  const body = ctxText.slice(start, ctxText.indexOf('\n}', start))
  const sinks = new Map()
  for (const m of body.matchAll(/^\s*(\w+)\(([^)]*)\)\s*:/gm)) {
    const params = m[2].split(',').map(p => p.trim())
    const idx = params.flatMap((p, i) => (/:\s*NonNegFinite$/.test(p) ? [i] : []))
    if (idx.length) sinks.set(m[1], { idx })
  }
  return sinks
}

// tsc orders emitted members by type id, which follows module-resolution order, so the
// same source emits its members in a different order per checkout. Sorting each
// block's members by code point makes the emitted text a function of the members.
function sortDeclarations(text) {
  return sortBlock(text.split('\n')).join('\n')
}

function sortBlock(lines) {
  const items = []
  let i = 0
  while (i < lines.length) {
    const start = i
    let balance = 0
    let inComment = false
    for (; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      const commentOnly = inComment || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')
      if (trimmed.includes('/*') && !trimmed.includes('*/')) inComment = true
      if (trimmed.includes('*/')) inComment = false
      for (const ch of lines[i]) {
        if (ch === '{') balance++
        else if (ch === '}') balance--
      }
      if (balance <= 0 && !inComment && !commentOnly) { i++; break }
    }
    items.push(sortInner(lines.slice(start, i)))
  }
  return items
    .map(item => ({ item, key: item.map(l => l.trim()).join('\n') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .flatMap(({ item }) => item)
}

function sortInner(item) {
  const first = item[0]
  const last = item[item.length - 1]
  if (item.length < 3 || !first.trimEnd().endsWith('{') || !last.trim().startsWith('}')) return item
  return [first, ...sortBlock(item.slice(1, -1)), last]
}

function withNonNegSinks(generated, ctxText) {
  const sinks = physicsNonNegSinks(ctxText)
  const alias = ctxText.match(/^export type NonNegFinite = [^;]+;/m)
  if (!alias) throw new Error(`[gen-sdk-typings] ${CTX_TYPES} declares no NonNegFinite alias`)
  const lines = sortDeclarations(generated).split('\n').map(line => {
    const m = line.match(/^(\s*)(\w+): \((.*)\)( => .*)$/)
    const sink = m && sinks.get(m[2])
    if (!sink) return line
    const params = m[3].split(', ')
    if (sink.idx.some(i => i >= params.length)) return line
    for (const i of sink.idx) params[i] =params[i].replace(/^(\w+\??): .*$/, '$1: NonNegFinite')
    return `${m[1]}${m[2]}: (${params.join(', ')})${m[4]}`
  })
  return `${alias[0]}\n\n${lines.join('\n')}`
}

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`[gen-sdk-typings] source not found: ${SOURCE}`)
    process.exit(1)
  }
  if (PRE_COMMIT) {
    await checkStagedClosure()
    return
  }
  if (!existsSync(TSC_BIN)) {
    console.error(`[gen-sdk-typings] tsc not found at ${TSC_BIN} -- is 'typescript' installed as a devDependency? (npm install --save-dev typescript)`)
    process.exit(1)
  }

  const index = indexSource(ROOT)
  const tmp = mkdtempSync(join(tmpdir(), 'sdk-typings-'))
  try {
    const tscTarget = await materializeStagedSnapshot(index)
    const digest = await index.digest()
    const emittedName = 'AppContext.d.ts'
    const args = [
      '--ignoreConfig',
      '--allowJs', '--declaration', '--emitDeclarationOnly',
      '--outDir', tmp,
      '--skipLibCheck',
      '--moduleResolution', 'bundler',
      '--module', 'esnext',
      '--target', 'es2022',
      '--checkJs', 'false',
      tscTarget
    ]
    console.log(`[gen-sdk-typings] running: node ${TSC_BIN} ${args.join(' ')}`)
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [TSC_BIN, ...args], { cwd: ROOT })
      if (stdout.trim()) console.log(stdout.trim())
      if (stderr.trim()) console.error(stderr.trim())
    } catch (e) {
      console.warn('[gen-sdk-typings] tsc reported diagnostics:')
      console.warn((e.stdout || e.message || String(e)).trim())
    }

    const emitted = findEmittedDeclaration(tmp, emittedName)
    if (!emitted) {
      console.error(`[gen-sdk-typings] tsc emitted no ${emittedName} under ${tmp} -- aborting, see diagnostics above.`)
      process.exit(1)
    }

    const generated = withNonNegSinks(readFileSync(emitted, 'utf8'), readFileSync(CTX_TYPES, 'utf8'))
    const header = `// AUTO-GENERATED by scripts/gen-sdk-typings.mjs (npm run gen-typings) from src/apps/AppContext.js.\n` +
      `// Structural inference only (AppContext.js has no formal @param/@returns JSDoc blocks yet, so\n` +
      `// parameter/return types are mostly 'any') -- NOT a drop-in replacement for the hand-curated\n` +
      `// client/editor/sdk-typings.d.ts Monaco typings. Regenerate: npm run gen-typings.\n// DO NOT EDIT BY HAND.\n` +
      `${DIGEST_LINE}${digest}\n\n`
    const output = header + generated

    if (CHECK_ONLY) {
      const committedRaw = existsSync(GENERATED_OUT) ? readFileSync(GENERATED_OUT, 'utf8') : null
      const committed = committedRaw === null ? null : normalizeEol(committedRaw)
      console.log(`[gen-sdk-typings] generated from the staged tree: HEAD worktree overlaid with any staged ${SOURCE_REL} closure member`)
      if (committed === normalizeEol(output)) {
        console.log(`[gen-sdk-typings] ${GENERATED_OUT} is up to date (${generated.split('\n').length} lines)`)
        return
      }
      const committedLines = (committed ?? '').split('\n')
      const outputLines = output.split('\n')
      const committedDigest = committed === null ? null : recordedDigest(committed)
      if (committedDigest !== null && committedDigest !== digest) {
        console.error(`[gen-sdk-typings] source digest: committed ${committedDigest.slice(0, 12)} vs generated ${digest.slice(0, 12)} -- ${SOURCE_REL} changed without regenerating`)
      }
      if (sameLineMultiset(committedLines, outputLines)) {
        console.log('[gen-sdk-typings] ' + GENERATED_OUT + ' is up to date (order-only difference; ' + outputLines.length + ' lines including header)')
        console.log('[gen-sdk-typings] NOTE: the committed file lists the same members in a different order. tsc orders emitted members by type id, which follows module-resolution order, so the order varies between checkouts of one commit while the member set does not; regenerating cannot fix it.')
        return
      }
      console.error(`[gen-sdk-typings] STALE: ${GENERATED_OUT} does not match the committed ${SOURCE_REL}`)
      console.error(`[gen-sdk-typings] committed ${committed === null ? '(missing)' : committedLines.length + ' lines'} vs generated ${outputLines.length} lines`)
      const onlyCommitted = linesOnlyIn(committedLines, outputLines)
      const onlyGenerated = linesOnlyIn(outputLines, committedLines)
      console.error('[gen-sdk-typings] only in committed (' + onlyCommitted.length + '):')
      for (const line of onlyCommitted.slice(0, 20)) console.error('    - ' + line)
      console.error('[gen-sdk-typings] only in generated (' + onlyGenerated.length + '):')
      for (const line of onlyGenerated.slice(0, 20)) console.error('    + ' + line)
      console.error('[gen-sdk-typings] fix: npm run gen-typings')
      process.exit(1)
    }

    writeFileSync(GENERATED_OUT, output, 'utf8')
    console.log(`[gen-sdk-typings] wrote ${GENERATED_OUT} (${generated.split('\n').length} lines)`)

    if (existsSync(HAND_MAINTAINED)) {
      const handText = readFileSync(HAND_MAINTAINED, 'utf8')
      const handNames = extractMemberNames(handText)
      const genNames = extractMemberNames(generated)

      const missingFromHand = [...genNames].filter(n => !handNames.has(n)).sort()
      const missingFromGenerated = [...handNames].filter(n => !genNames.has(n)).sort()

      console.log('\n[gen-sdk-typings] drift report vs client/editor/sdk-typings.d.ts:')
      console.log(`  members in generated but not in hand-maintained (${missingFromHand.length}): ${missingFromHand.join(', ') || '(none)'}`)
      console.log(`  members in hand-maintained but not in generated  (${missingFromGenerated.length}): ${missingFromGenerated.join(', ') || '(none)'}`)
    } else {
      console.log(`[gen-sdk-typings] no hand-maintained file at ${HAND_MAINTAINED} to diff against.`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
    discardStagedSnapshot()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
