import { withGpuPage, drainedSampleGroundMExpr } from './lib/gpu-eval.mjs'

const BOOL_FLAGS = new Set(['drain'])
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
const expr = args.drain ? drainedSampleGroundMExpr(`(${exprIn})`) : exprIn

const out = await withGpuPage({ port: Number(args.port || process.env.PORT || 8090), angle: args.angle || process.env.ANGLE || 'd3d11' }, async (evalIn, { screenshot, vendor }) => {
  console.error(`[gpu-eval] renderer=${vendor}`)
  if (args.shot) { await screenshot(args.shot); console.error(`[gpu-eval] wrote ${args.shot}`) }
  return evalIn(expr)
}).catch(e => { console.error('[gpu-eval] error:', e.message); process.exit(1) })

console.log(JSON.stringify(out.result, null, 2))
