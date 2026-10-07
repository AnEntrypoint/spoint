import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const ROOTS = ['src', 'client', 'apps', 'scripts', 'bin']
const SKIP_DIRS = new Set(['basis', 'draco', 'maps'])
const SKIP_VENDORED_FILE = /(\.min\.js$|basis_transcoder|draco_decoder|jolt-physics)/

function untracked() {
  const raw = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard', '--', ...ROOTS], { maxBuffer: 64 * 1024 * 1024 })
  return raw.toString('utf8').split('\0').filter(Boolean).filter(rel => {
    const ext = extname(rel)
    if (ext !== '.js' && ext !== '.mjs') return false
    if (SKIP_VENDORED_FILE.test(rel)) return false
    return !rel.split(/[\\/]/).some(seg => SKIP_DIRS.has(seg))
  })
}

async function main() {
  const files = untracked()
  if (!files.length) {
    console.log(`check-scratch: no untracked .js/.mjs under ${ROOTS.join(', ')}`)
    return
  }
  const failures = []
  let idx = 0
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++]
      try {
        const buf = readFileSync(file)
        if (buf.length && buf[buf.length - 1] === 0) { failures.push({ file, error: 'trailing NUL byte(s) - file is corrupted' }); continue }
      } catch (e) { failures.push({ file, error: 'unreadable: ' + e.message }); continue }
      try { await execFileAsync(process.execPath, ['--check', file]) }
      catch (e) { failures.push({ file, error: (e.stderr || e.message || '').toString().split('\n').slice(0, 3).join(' ') }) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker))
  if (!failures.length) {
    console.log(`check-scratch: ${files.length} untracked scratch file(s) parse cleanly`)
    return
  }
  console.error(`check-scratch: ${failures.length} of ${files.length} untracked scratch file(s) failed to parse:`)
  for (const f of failures) console.error(`  ${f.file}: ${f.error}`)
  process.exit(1)
}

main().catch(e => { console.error('check-scratch: harness error:', e); process.exit(2) })
