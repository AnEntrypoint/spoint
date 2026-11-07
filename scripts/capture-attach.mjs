#!/usr/bin/env node
import { attachCapture, STATE_PATH } from './lib/capture-server.mjs'

const argv = process.argv.slice(2)
const arg = (n) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null }
const result = await attachCapture({ statePath: arg('state') || STATE_PATH, expectSha256: arg('expect-sha256') })
if (result.ok) {
  console.log(`RESULT: ATTACHED url=${result.url} pid=${result.pid} sha=${result.sha256.slice(0, 12)} client-root=bundle`)
} else {
  console.log(`RESULT: REFUSED reason=${result.reason} -- ${result.detail}`)
  process.exitCode = 3
}
