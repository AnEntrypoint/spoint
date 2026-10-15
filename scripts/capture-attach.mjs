#!/usr/bin/env node
// Attach mode for capture harnesses (PERF-grass-frame-harness-friction-1013). Checks that the shared
// capture server (scripts/capture-server.mjs) is up and serves the bundle this checkout built, then
// prints the URL a page load should use. It never starts a server and never launches a browser: a
// browser capture that attaches closes its own page in its finally block and exits with a named reason.
// Usage: node scripts/capture-attach.mjs [--expect-sha256=<hex>] [--state=<path>]
// Exit: 0 ATTACHED, 3 REFUSED (reason named on the RESULT line).
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
