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
if (!exprIn) { console.error("usage: node scripts/gpu-eval.mjs [--drain] [--backend legacygl|webgpu] [--port N] [--shot f.png] '<js expr>'"); process.exit(2) }
const expr = args.drain ? drainedSampleGroundMExpr(`(${exprIn})`) : exprIn

const backend = typeof args.backend === 'string' ? args.backend : 'legacygl'
const out = await withGpuPage({ port: Number(args.port || process.env.PORT || 8090), backend, angle: typeof args.angle === 'string' ? args.angle : null }, async (evalIn, { screenshot, probeGpu }) => {
  const gpu = await probeGpu()
  console.error(`[gpu-eval] renderer=${gpu.renderer} vendor=${gpu.vendor} accelerated=${gpu.accelerated}`)
  if (args.shot) { await screenshot(args.shot); console.error(`[gpu-eval] wrote ${args.shot}`) }
  return evalIn(expr)
}).catch(e => { console.error('[gpu-eval] error:', e.message); process.exit(1) })

console.log(JSON.stringify(out, null, 2))
