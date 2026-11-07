import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const probe = fileURLToPath(new URL('./prd-tail-msgpack-settle-probe.mjs', import.meta.url))
const out = execFileSync(process.execPath, [probe], { encoding: 'utf8' })
const line = out.split('\n').find(l => l.startsWith('csproto-3 '))
const refuted = line !== undefined && line.startsWith('csproto-3 NOT-CONFIRMED')
process.stdout.write(out)
console.log('RESULT: ' + (refuted ? 'PASS' : 'FAIL') + ' csproto-3 refutation reproduces at HEAD: the probe prints NOT-CONFIRMED for the row claim (pack throws before ensurePacked settles)')
process.exitCode = refuted ? 0 : 1
