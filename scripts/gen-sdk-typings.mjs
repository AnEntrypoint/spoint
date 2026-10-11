#!/usr/bin/env node
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SOURCE = join(ROOT, 'src/apps/AppContext.js')
const HAND_MAINTAINED = join(ROOT, 'client/editor/sdk-typings.d.ts')
const GENERATED_OUT = join(ROOT, 'client/editor/sdk-typings.generated.d.ts')
const TSC_BIN = join(ROOT, 'node_modules/typescript/bin/tsc')
const CHECK_ONLY = process.argv.includes('--check')
const PRE_COMMIT = process.argv.includes('--pre-commit')
const SOURCE_REL = 'src/apps/AppContext.js'
const GENERATED_REL = 'client/editor/sdk-typings.generated.d.ts'
const SNAPSHOT_DIR = join(ROOT, '.gm', 'tmp', 'sdk-typings-staged')
const DIGEST_LINE = '// source digest: '
const MAX_BUFFER = 256 * 1024 * 1024

function git(...args) {
  const env = { ...process.env }
  delete env.GIT_INDEX_FILE
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', env, maxBuffer: MAX_BUFFER })
}

function gitIndex(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n')
}

function gitCatFileBatch(shas) {
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd: ROOT,
    input: Buffer.from(shas.join('\n') + '\n', 'utf8'),
    maxBuffer: MAX_BUFFER
  })
  const got = new Map()
  let off = 0
  while (off < out.length) {
    const nl = out.indexOf(0x0a, off)
    if (nl < 0) break
    const header = out.slice(off, nl).toString('utf8').split(' ')
    off = nl + 1
    if (header.length < 3) continue
    const size = Number(header[2])
    if (!Number.isFinite(size) || size < 0) break
    got.set(header[0], out.slice(off, off + size).toString('utf8'))
    off += size + 1
  }
  return got
}

function importSpecifiers(text) {
  const specs = []
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /(?:^|[\n;{}])\s*import\s*['"]([^'"\n]+)['"]/g
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(text))) specs.push(m[1])
  }
  return specs
}

function resolveClosureMember(has, fromRel, spec) {
  if (!spec.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec))
  for (const candidate of [base, base + '.js', base + '.mjs', posix.join(base, 'index.js')]) {
    if (has(candidate)) return candidate
  }
  return null
}

function indexSource() {
  const shas = new Map()
  for (const line of gitIndex('ls-files', '--stage').split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(0, tab).trim().split(/\s+/)
    if (meta.length < 2) continue
    shas.set(line.slice(tab + 1), meta[1])
  }
  const contents = new Map()
  const load = (want) => {
    const got = gitCatFileBatch(want)
    for (const sha of want) contents.set(sha, got.has(sha) ? got.get(sha) : null)
  }
  const has = (rel) => shas.has(rel)
  const read = (rel) => {
    const sha = shas.get(rel)
    if (sha === undefined) return null
    if (!contents.has(sha)) load([sha])
    return contents.get(sha)
  }
  let members = null
  return {
    members() {
      if (members !== null) return members
      const seen = new Set()
      let frontier = [SOURCE_REL]
      for (;;) {
        const want = new Set()
        for (const rel of frontier) {
          const sha = shas.get(rel)
          if (sha !== undefined && !contents.has(sha)) want.add(sha)
        }
        if (want.size) load([...want])
        const next = []
        for (const rel of frontier) {
          if (seen.has(rel)) continue
          seen.add(rel)
          const text = read(rel)
          if (text === null) continue
          for (const spec of importSpecifiers(text)) {
            const member = resolveClosureMember(has, rel, spec)
            if (member !== null && !seen.has(member)) next.push(member)
          }
        }
        if (next.length === 0) break
        frontier = next
      }
      members = [...seen].sort()
      return members
    },
    digest() {
      const outer = createHash('sha256')
      for (const rel of this.members()) {
        const text = read(rel)
        if (text === null) continue
        const inner = createHash('sha256').update(normalizeEol(text), 'utf8').digest('hex')
        outer.update(rel + '\u0000' + inner + '\n')
      }
      return outer.digest('hex')
    }
  }
}

function discardStagedSnapshot() {
  rmSync(SNAPSHOT_DIR, { recursive: true, force: true })
  try { git('worktree', 'prune') } catch { }
}

function materializeStagedSnapshot(index) {
  discardStagedSnapshot()
  git('worktree', 'add', '--detach', SNAPSHOT_DIR, 'HEAD')
  symlinkSync(join(ROOT, 'node_modules'), join(SNAPSHOT_DIR, 'node_modules'), 'junction')
  const staged = new Set(stagedPaths())
  for (const rel of index.members()) {
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

function recordedDigest(text) {
  const m = text.match(/\/\/ source digest: ([0-9a-f]{64})/)
  return m === null ? null : m[1]
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

function checkStagedClosure() {
  const staged = stagedPaths()
  if (staged.length === 0) return
  const index = indexSource()
  const touched = staged.filter(p => index.members().includes(p))
  if (touched.length === 0) return
  const digest = index.digest()

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
  console.log(`[gen-sdk-typings] ${GENERATED_REL} matches the staged ${SOURCE_REL} import closure (${digest.slice(0, 12)}, ${index.members().length} files)`)
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

async function main() {
  if (!existsSync(SOURCE)) {
    console.error(`[gen-sdk-typings] source not found: ${SOURCE}`)
    process.exit(1)
  }
  if (PRE_COMMIT) {
    checkStagedClosure()
    return
  }
  if (!existsSync(TSC_BIN)) {
    console.error(`[gen-sdk-typings] tsc not found at ${TSC_BIN} -- is 'typescript' installed as a devDependency? (npm install --save-dev typescript)`)
    process.exit(1)
  }

  const index = indexSource()
  const tmp = mkdtempSync(join(tmpdir(), 'sdk-typings-'))
  try {
    const tscTarget = materializeStagedSnapshot(index)
    const digest = index.digest()
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

    const generated = readFileSync(emitted, 'utf8')
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
