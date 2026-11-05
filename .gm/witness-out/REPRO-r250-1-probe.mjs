import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/workspace/spoint'
const OUT = join(ROOT, 'client/editor/sdk-typings.generated.d.ts')
const sha = () => createHash('sha256').update(readFileSync(OUT)).digest('hex')

function run() {
  execFileSync('npm', ['run', '-s', 'gen-typings'], { cwd: ROOT, stdio: 'ignore' })
  return sha()
}

const first = run()
const second = run()
const lines = [
  'REPRO-r250-1 probe: gen-typings run twice, sha256 of client/editor/sdk-typings.generated.d.ts',
  `run1 sha256: ${first}`,
  `run2 sha256: ${second}`,
  `match: ${first === second ? 'yes' : 'no'}`
]
const text = lines.join('\n') + '\n'
writeFileSync(join(ROOT, '.gm/witness-out/REPRO-r250-1-verdict.txt'), text)
process.stdout.write(text)
process.exit(first === second ? 0 : 1)
