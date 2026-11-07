import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const AUDIT = '/tmp/hy3d-sd-audit.md'
const HY3D = '/workspace/hy3d'
const SPOINT = '/workspace/spoint'
const TICK = String.fromCharCode(96)

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { ok: r.status === 0, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

function sectionLines(lines, startPrefix, endPrefix) {
  const start = lines.findIndex(l => l.startsWith(startPrefix))
  if (start < 0) return []
  let end = lines.findIndex((l, i) => i > start && l.startsWith(endPrefix))
  if (end < 0) end = lines.length
  return lines.slice(start + 1, end)
}

function parseAudit() {
  const lines = fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/)
  const tableLines = sectionLines(lines, '## Per-file table', '## Comment lines')
  const commentLines = sectionLines(lines, '## Comment lines', '## Redacted possible-secret list')
  const secretLines = sectionLines(lines, '## Redacted possible-secret list', '## Caveats')
  const table = []
  const shebangs = []
  const findings = []
  for (const line of tableLines) {
    if (line.startsWith('| ' + TICK + '/workspace/hy3d/')) {
      const parts = line.split(TICK)
      if (parts.length > 1) table.push(parts[1])
    }
  }
  for (const line of commentLines) {
    if (line.startsWith('- ' + TICK + '/workspace/hy3d/') && line.includes('[shebang]')) {
      const parts = line.split(TICK)
      if (parts.length > 1) shebangs.push(parts[1].split(':')[0])
    }
  }
  for (const line of secretLines) {
    if (line.startsWith('- ' + TICK + '/workspace/hy3d/') && line.includes(' - ')) {
      const parts = line.split(TICK)
      if (parts.length > 1) {
        const rest = line.slice(line.indexOf(' - ') + 3)
        const kind = rest.replace(/\s*\| value: \[REDACTED\].*$/, '')
        findings.push({ file: parts[1].split(':')[0], kind })
      }
    }
  }
  return { table: [...new Set(table)], shebangs: [...new Set(shebangs)], findings }
}

function commentKind(line) {
  const t = line.trimStart()
  if (t.startsWith('#!')) return 'shebang'
  if (t.startsWith('//')) return 'line-comment'
  if (t.startsWith('#')) return 'hash-comment'
  if (t.startsWith('/*')) return 'block-comment'
  if (t.startsWith('*')) return 'block-comment'
  if (t.startsWith('<!--')) return 'html-comment'
  return null
}

const JS_FILE = /\.(m?js|cjs)$/
const HASH_FILE = /\.(py|sh)$/

function trailingCommentKind(line, file) {
  const js = JS_FILE.test(file)
  const hash = HASH_FILE.test(file)
  if (!js && !hash) return null
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === TICK) { quote = c; continue }
    if (js && c === '/' && line[i + 1] === '/') return 'trailing-line-comment'
    if (js && c === '/' && line[i + 1] === '*') return 'trailing-block-comment'
    if (hash && c === '#' && line[i - 1] !== '$' && line[i - 1] !== '{') return 'trailing-hash-comment'
  }
  return null
}

function commentViolations(file, shebangSet) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const out = []
  lines.forEach((line, i) => {
    const kind = commentKind(line) || trailingCommentKind(line, file)
    if (!kind) return
    if (kind === 'shebang' && i === 0 && shebangSet.has(file)) return
    out.push({ line: i + 1, kind })
  })
  return out
}

function shebangKept(file) {
  const first = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0] || ''
  return first.trimStart().startsWith('#!')
}

const RAW_SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /https?:\/\/[^\s/]*:[^\s/@]+@/g,
]

function rawSecretHitsIn(text) {
  return RAW_SECRET_PATTERNS.reduce((n, p) => n + (text.match(new RegExp(p.source, p.flags)) || []).length, 0)
}

function rawSecretHits(file) {
  return rawSecretHitsIn(fs.readFileSync(file, 'utf8'))
}

const ENV_REF = /process\.env\.|import\.meta\.env|os\.environ|secrets\.|Deno\.env|getenv\(|ENV\[/g
const AUTH_REF = /Authorization|authorization|Bearer|bearer|X-API-Key|api[_-]?key/gi

function referenceCount(file, kind) {
  const text = fs.readFileSync(file, 'utf8')
  const re = /environment variable/.test(kind) ? ENV_REF : AUTH_REF
  return (text.match(new RegExp(re.source, re.flags)) || []).length
}

function tsvCheck(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.length > 0)
  if (!lines.length) return { ok: false, out: '', err: 'empty TSV' }
  const cols = lines[0].split('\t').length
  const bad = lines.filter(l => l.split('\t').length !== cols).length
  return { ok: bad === 0, out: 'rows=' + lines.length + ' cols=' + cols, err: bad ? 'column_mismatch=' + bad : '' }
}

function syntaxCheck(file) {
  if (/\.(mjs|js)$/.test(file)) return run('node', ['--check', file])
  if (/\.py$/.test(file)) return run('python3', ['-c', "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file])
  if (/\.sh$/.test(file)) return run('bash', ['-n', file])
  if (/\.tsv$/.test(file)) return tsvCheck(file)
  return { ok: true, out: 'no-syntax-check', err: '' }
}

function commitChecks(sha, files) {
  const fetch = run('git', ['-C', HY3D, 'fetch', 'origin', 'main'])
  const show = run('git', ['-C', HY3D, 'show', '-s', '--format=%H%n%an%n%ae%n%cn%n%ce%n%B', sha])
  if (!show.ok) return { ok: false, reason: 'git-show-failed' }
  const parts = show.out.trim().split('\n')
  const full = parts[0]
  const an = parts[1]
  const ae = parts[2]
  const cn = parts[3]
  const ce = parts[4]
  const bodyText = parts.slice(5).join('\n')
  const authorOk = an === 'lanmower' && cn === 'lanmower'
  const trailerFree = !/Co-Authored-By|Generated with/i.test(bodyText)
  const ls = run('git', ['-C', HY3D, 'ls-remote', 'origin', 'main'])
  const remoteLine = ls.out.trim().split('\n')[0] || ''
  const remote = remoteLine.split(/\s+/)[0] || ''
  const ancestry = run('git', ['-C', HY3D, 'merge-base', '--is-ancestor', sha, remote])
  const pushedOk = remote.startsWith(sha) || remote === full || (ancestry.ok && remote.length > 0)
  const tree = run('git', ['-C', HY3D, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha])
  const paths = tree.out.trim().split('\n').filter(Boolean)
  const rel = files.map(f => f.replace('/workspace/hy3d/', ''))
  const missing = rel.filter(p => !paths.includes(p))
  const envCommitted = paths.includes('.env')
  const status = run('git', ['-C', HY3D, 'status', '--porcelain', '--', ...rel])
  const clean = status.out.trim().length === 0
  const ok = fetch.ok && authorOk && trailerFree && pushedOk && missing.length === 0 && !envCommitted && clean
  return { ok, fetched: fetch.ok, full, an, ae, cn, ce, remote, pushedOk, trailerFree, authorOk, paths: paths.length, missing, envCommitted, clean }
}

function spointState() {
  const status = run('git', ['-C', SPOINT, 'status', '--porcelain', '--untracked-files=no'])
  const tracked = status.out.trim().split('\n').filter(Boolean).length
  const head = run('git', ['-C', SPOINT, 'rev-parse', '--short', 'HEAD']).out.trim()
  const ls = run('git', ['-C', SPOINT, 'ls-remote', 'origin', 'main'])
  const remote = (ls.out.trim().split('\n')[0] || '').split(/\s+/)[0].slice(0, 7)
  return { tracked, head, remote, unchanged: tracked === 0 && head.length > 0 && head === remote }
}

function buildReport(s) {
  const lines = []
  lines.push('# hy3d comment sweep independent verification')
  lines.push('')
  lines.push('Commit: ' + s.sha)
  lines.push('Result: ' + (s.pass ? 'PASS' : 'FAIL'))
  lines.push('Generated from read-only checks; no repository file was edited by spoint.')
  lines.push('')
  lines.push('## Method')
  lines.push('Parsed /tmp/hy3d-sd-audit.md for the 37 audited paths, 6 original shebang files and 9 redacted possible-secret findings.')
  lines.push('No .env file was read; no secret values were printed or stored; no shell grep or find was used.')
  lines.push('Syntax checks: node --check for .mjs/.js, ast.parse for .py, bash -n for .sh, column-count check for .tsv.')
  lines.push('Commit checks: git show, git ls-remote, git merge-base, git diff-tree, git status --porcelain for the 37 paths.')
  lines.push('')
  lines.push('## Done-condition checks')
  lines.push('Prose comment violations: ' + s.violationCount + (s.commentFindings.length ? ' in ' + s.commentFindings.map(x => x.file + ':' + x.violations.length).join(', ') : ''))
  lines.push('Shebangs kept: ' + (s.shebangSetSize - s.shebangMissing.length) + '/' + s.shebangSetSize + (s.shebangMissing.length ? '; missing: ' + s.shebangMissing.join(', ') : ''))
  lines.push('Code references present: ' + s.refTotal + ' token matches across ' + s.refChecks.length + ' finding files; missing: ' + (s.refMissing.length ? s.refMissing.join(', ') : 'none'))
  lines.push('Removed references: ' + (s.removedRefs.length ? s.removedRefs.join(', ') : 'none') + ' (expected after the prose comment sweep; no raw values printed)')
  lines.push('Raw secret value patterns in files: ' + s.rawFileHits)
  lines.push('Raw secret value patterns in this report: ' + s.reportRaw)
  lines.push('Syntax checks passed: ' + (s.syntax.length - s.syntaxFailures.length) + '/' + s.syntax.length + (s.syntaxFailures.length ? '; failures: ' + s.syntaxFailures.join(', ') : ''))
  lines.push('Commit ok: ' + s.commit.ok + '; authorOk=' + s.commit.authorOk + '; pushedOk=' + s.commit.pushedOk + '; trailerFree=' + s.commit.trailerFree + '; clean=' + s.commit.clean + '; envCommitted=' + s.commit.envCommitted)
  lines.push('Commit: full=' + (s.commit.full || 'n/a') + ' author=' + (s.commit.an || 'n/a') + ' committer=' + (s.commit.cn || 'n/a') + ' remote=' + (s.commit.remote || 'n/a') + ' paths=' + (s.commit.paths || 0) + ' missing=' + (s.commit.missing ? s.commit.missing.length : 0) + (s.commit.reason ? ' reason=' + s.commit.reason : ''))
  if (s.commit.missing && s.commit.missing.length) lines.push('Missing from commit: ' + s.commit.missing.join(', '))
  lines.push('Spoint state (informational): tracked=' + s.spoint.tracked + ' head=' + s.spoint.head + ' remote=' + s.spoint.remote + ' unchanged=' + s.spoint.unchanged)
  lines.push('')
  lines.push('## Caveats')
  s.caveats.forEach(c => lines.push('- ' + c))
  lines.push('')
  lines.push('Result: ' + (s.pass ? 'PASS' : 'FAIL'))
  return lines.join('\n') + '\n'
}

const args = process.argv.slice(2)
const audit = parseAudit()
const files = audit.table
const shebangSet = new Set(audit.shebangs)
const findings = audit.findings

if (args[0] === '--self-test') {
  const exists = files.every(f => fs.existsSync(f))
  const syntax = files.map(f => ({ file: f, ok: syntaxCheck(f).ok }))
  const raw = files.reduce((n, f) => n + rawSecretHits(f), 0)
  const ok = files.length === 37 && shebangSet.size === 6 && findings.length === 9 && exists && syntax.every(x => x.ok) && raw === 0
  console.log(JSON.stringify({ mode: 'self-test', files: files.length, shebangs: shebangSet.size, findings: findings.length, exists, syntaxFailures: syntax.filter(x => !x.ok).map(x => x.file), rawSecretHits: raw, ok }))
  process.exit(ok ? 0 : 1)
}

const sha = (args[0] || '').toLowerCase()
if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) {
  console.error('usage: node /tmp/hy3d-comment-sweep-verify.mjs <commit-sha>')
  process.exit(2)
}

const commentFindings = files.map(f => ({ file: f, violations: commentViolations(f, shebangSet) })).filter(x => x.violations.length)
const violationCount = commentFindings.reduce((n, x) => n + x.violations.length, 0)
const shebangMissing = [...shebangSet].filter(f => !shebangKept(f))
const rawFileHits = files.reduce((n, f) => n + rawSecretHits(f), 0)
const refChecks = findings.map(f => ({ file: f.file, kind: f.kind, count: referenceCount(f.file, f.kind) }))
const removedRefs = ['/workspace/hy3d/work/combat/mk-tsv.py']
const refMissing = refChecks.filter(x => x.count === 0).map(x => x.file).filter(f => !removedRefs.includes(f))
const refTotal = refChecks.reduce((n, x) => n + x.count, 0)
const syntax = files.map(f => ({ file: f, ok: syntaxCheck(f).ok }))
const syntaxFailures = syntax.filter(x => !x.ok).map(x => x.file)
const commit = commitChecks(sha, files)
const spoint = spointState()
const hy3dOk = violationCount === 0 && shebangMissing.length === 0 && rawFileHits === 0 && refMissing.length === 0 && syntaxFailures.length === 0 && commit.ok
const caveats = [
  'Comment detection is lexical; a shebang is allowed only on line 1 of a file that originally had one.',
  'Trailing comments are detected per line; a // or # inside a multi-line string or a JS regex literal can be misread.',
  'Secret matching is heuristic; references remain in code and no literal values were printed or stored.',
  'TSV syntax check verifies a header and uniform tab-delimited column counts only.',
  'Remote push check accepts the commit as origin/main itself or an ancestor of the current origin/main head.',
  'The mk-tsv.py authorization/bearer reference from the original audit was a prose comment removed by the sweep; it is reported as removed, not required.',
  'Spoint state is informational and is not part of the hy3d pass condition.',
  'No .env file was read; no repository file was edited, staged, committed, pushed or deleted by this verification; the only remote operation is a read-only git fetch origin main in hy3d.',
]
const state = { sha, commentFindings, violationCount, shebangSetSize: shebangSet.size, shebangMissing, rawFileHits, refChecks, refTotal, refMissing, removedRefs, syntax, syntaxFailures, commit, spoint, caveats }
const draft = buildReport({ ...state, pass: hy3dOk, reportRaw: 0 })
const reportRaw = rawSecretHitsIn(draft)
const pass = hy3dOk && reportRaw === 0
process.stdout.write(buildReport({ ...state, pass, reportRaw }))
console.log(JSON.stringify({ pass, files: files.length, violationCount, shebangMissing: shebangMissing.length, rawFileHits, refTotal, refMissing: refMissing.length, removedRefs: removedRefs.length, syntaxFailures: syntaxFailures.length, commitOk: commit.ok, spointUnchanged: spoint.unchanged, reportRaw }))
process.exit(pass ? 0 : 1)
