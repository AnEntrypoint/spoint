import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const probe = fileURLToPath(new URL('./prd-tail-protocol-probe-v2.mjs', import.meta.url))
const out = execFileSync(process.execPath, [probe], { encoding: 'utf8' })
const line = out.split('\n').find(l => l.startsWith('csproto-2 '))
const refuted = line !== undefined && line.startsWith('csproto-2 NOT-CONFIRMED')
process.stdout.write(out)
console.log('RESULT: ' + (refuted ? 'PASS' : 'FAIL') + ' csproto-2 refutation reproduces at HEAD: the probe prints NOT-CONFIRMED for the row claim (msgName and isUnreliable on an unknown id)')
process.exitCode = refuted ? 0 : 1
