// gpu-eval.mjs -- one-shot: run arbitrary JS against spoint's LIVE page/shader from the CLI and print
// the result. "code execution in the browser" from node, for ad-hoc testing of the GPU terrain etc.
//
// Usage:
//   PORT=8090 node server.js &                       # (a server must be up)
//   node scripts/gpu-eval.mjs 'window.__terrain.planet.render.sampleGroundM(window.__terrain.frame.localToDir(100,0))'
//   node scripts/gpu-eval.mjs --drain 'window.__terrain.frame.localToDir(100,0)'   # drained GPU height for a dir-expr
//   node scripts/gpu-eval.mjs --angle swiftshader 'navigator.userAgent'
//   node scripts/gpu-eval.mjs --shot out.png 'window.__terrain ? "ok" : "no-terrain"'   # also screenshot
//
// The expression is wrapped in an async IIFE; await is allowed. Result is JSON-printed to stdout.

import { withGpuPage, drainedSampleGroundMExpr } from './lib/gpu-eval.mjs'

const BOOL_FLAGS = new Set(['drain'])   // value-less flags; everything else takes the next token
function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) { const k = t.slice(2); const n = argv[i + 1]; if (BOOL_FLAGS.has(k) || n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++ } }
    else a._.push(t)
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const exprIn = args._.join(' ')
if (!exprIn) { console.error("usage: node scripts/gpu-eval.mjs [--drain] [--angle d3d11|swiftshader] [--port N] [--shot f.png] '<js expr>'"); process.exit(2) }
// --drain: treat the expression as a DIR expression and return the drained (stable) GPU sampleGroundM for it.
const expr = args.drain ? drainedSampleGroundMExpr(`(${exprIn})`) : exprIn

const out = await withGpuPage({ port: Number(args.port || process.env.PORT || 8090), angle: args.angle || process.env.ANGLE || 'd3d11' }, async (evalIn, { screenshot, vendor }) => {
  console.error(`[gpu-eval] renderer=${vendor}`)
  if (args.shot) { await screenshot(args.shot); console.error(`[gpu-eval] wrote ${args.shot}`) }
  return evalIn(expr)
}).catch(e => { console.error('[gpu-eval] error:', e.message); process.exit(1) })

console.log(JSON.stringify(out.result, null, 2))
