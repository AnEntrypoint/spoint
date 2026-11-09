import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'e8c0c3d'
const LEDGER = 'docs/PENDING_VALIDATION.md'
const CODE_ROOTS = ['src', 'client', 'apps', 'packages', 'edge', 'bin']
const CODE_FILE = /\.(?:m?js|cjs|ts|glsl|wgsl)$/
const AUDIT_ROW = /^\| ([A-Za-z0-9_./-]+\.(?:m?js|cjs|ts|glsl|wgsl))(?::[\d-]+)? \| [^|]*\| (changed|kept) \|/

const git = args => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 30 })
const digest = buf => createHash('sha256').update(buf).digest('hex')
const baseDigest = file => { try { return digest(git(['show', BASE + ':' + file])) } catch { return null } }
const workDigest = file => { try { return digest(readFileSync(path.join(ROOT, file))) } catch { return null } }

const kindsByFile = new Map()
for (const line of readFileSync(path.join(ROOT, LEDGER), 'utf8').split('\n')) {
  const match = AUDIT_ROW.exec(line)
  if (!match) continue
  const kinds = kindsByFile.get(match[1]) ?? new Set()
  kinds.add(match[2])
  kindsByFile.set(match[1], kinds)
}

const covered = [...kindsByFile.keys()].sort().map(file => {
  const expected = kindsByFile.get(file).has('changed') ? 'differ' : 'identical'
  const base = baseDigest(file)
  const work = workDigest(file)
  const differs = base !== null && work !== null && base !== work
  const identical = base !== null && work !== null && base === work
  return { file, expected, base, work, differs, ok: expected === 'differ' ? differs : identical }
})

const unledgered = git(['diff', '--name-only', BASE, '--', ...CODE_ROOTS])
  .toString('utf8').split('\n').filter(file => CODE_FILE.test(file) && !kindsByFile.has(file))

for (const r of covered) console.log((r.ok ? 'ok   ' : 'FAIL ') + 'expected=' + r.expected.padEnd(9) + ' base=' + (r.base ?? 'absent') + ' work=' + (r.work ?? 'absent') + ' ' + r.file)
for (const file of unledgered) console.log('FAIL unledgered code change: ' + file)

const differing = covered.filter(r => r.differs).length
const failed = covered.filter(r => !r.ok).length
console.log('covered ' + covered.length + ' file(s): ' + differing + ' differ from ' + BASE + ', ' + (covered.length - differing) + ' identical to ' + BASE + '; unledgered code changes ' + unledgered.length)
const pass = failed === 0 && unledgered.length === 0
console.log(pass
  ? 'RESULT: PASS ' + covered.length + ' audited file(s) match their run 23 row against ' + BASE + ': changed files differ, kept files are byte-identical, and no code file outside the rows changed'
  : 'RESULT: FAIL ' + failed + ' audited file(s) disagree with their row and ' + unledgered.length + ' code file(s) changed without a row, against ' + BASE)
process.exit(pass ? 0 : 1)
