import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED = path.join(ROOT, 'docs/index.html')
const GENERATOR = path.join(ROOT, 'scripts/generate-docs-site.js')

const dir = mkdtempSync(path.join(tmpdir(), 'docs-freshness-'))
const generated = path.join(dir, 'index.html')
try {
  execFileSync(process.execPath, [GENERATOR, '--out', generated], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const committed = readFileSync(COMMITTED, 'utf8')
  const fresh = readFileSync(generated, 'utf8')
  const sectionsCommitted = (committed.match(/<section id="section-\d+">/g) || []).length
  const sectionsFresh = (fresh.match(/<section id="section-\d+">/g) || []).length
  console.log(`docs/index.html sections=${sectionsCommitted} generator sections=${sectionsFresh} bytes=${committed.length} generator bytes=${fresh.length}`)
  const ok = committed === fresh
  if (!ok) {
    const a = committed.split('\n')
    const b = fresh.split('\n')
    let first = 0
    while (first < Math.min(a.length, b.length) && a[first] === b[first]) first += 1
    console.log(`first differing line ${first + 1}: committed=${JSON.stringify((a[first] || '').slice(0, 120))} generated=${JSON.stringify((b[first] || '').slice(0, 120))}`)
    console.log('RESULT: FAIL docs/index.html is not the generator output: run node scripts/generate-docs-site.js and commit the page with the source change')
    process.exitCode = 1
  } else {
    console.log('RESULT: PASS docs/index.html equals the output of scripts/generate-docs-site.js for the current sources')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
