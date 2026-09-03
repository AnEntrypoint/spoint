import fs from 'node:fs'
import { withGpuPage } from './lib/gpu-eval.mjs'

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const k = t.slice(2); const n = argv[i + 1]
      if (n === undefined || n.startsWith('--')) a[k] = true
      else { a[k] = n; i++ }
    } else a._.push(t)
  }
  return a
}

const args = parseArgs(process.argv.slice(2))
const N = Number(args.n || 7)
const EXTENT = Number(args.extent || 256)
const PORT = Number(args.port || process.env.PORT || 8090)
const TOL = args.tol != null ? Number(args.tol) : null

const sweep = `
const N = ${N}, EXTENT = ${EXTENT};
const half = EXTENT / 2, step = N > 1 ? EXTENT / (N - 1) : 0;
const rows = [];
for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
  const x = Math.round(-half + ix * step), z = Math.round(-half + iz * step);
  const dir = __t.frame.localToDir(x, z);
  const cpu = __t.heightAt(dir);
  let gpu = __R.sampleGroundMSync(dir);
  for (let k = 0; k < 8 && !(gpu != null && isFinite(gpu)); k++) {
    __R.sampleGroundM(dir);
    await new Promise(r => requestAnimationFrame(r));
    gpu = __R.sampleGroundMSync(dir);
  }
  const okc = typeof cpu === 'number' && isFinite(cpu);
  const okg = gpu != null && isFinite(gpu);
  rows.push({
    x, z,
    cpu: okc ? +cpu.toFixed(3) : null,
    gpu: okg ? +gpu.toFixed(3) : null,
    gap: (okc && okg) ? +Math.abs(gpu - cpu).toFixed(3) : null,
  });
}
const gl = document.createElement('canvas').getContext('webgl2');
const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
return {
  renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '?',
  n: N, extent: EXTENT, rows,
};
`.trim()

const out = await withGpuPage({ port: PORT }, async (run) => {
  const r = await run(sweep)
  return r.result
}).catch(e => { console.error('[parity] error:', e.message); process.exit(1) })

const gaps = out.rows.map(r => r.gap).filter(g => g != null)
const meanGap = gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(3) : null
const maxGap = gaps.length ? +Math.max(...gaps).toFixed(3) : null
const report = { renderer: out.renderer, n: out.n, extent: out.extent, samples: gaps.length, meanGap, maxGap, rows: out.rows }

console.error(`[parity] renderer=${out.renderer} samples=${gaps.length}/${out.rows.length}`)
console.log(JSON.stringify(report, null, 2))
if (args.json) { fs.writeFileSync(args.json, JSON.stringify(report, null, 2)); console.error(`[parity] wrote ${args.json}`) }

if (!gaps.length) { console.error('[parity] no valid CPU/GPU sample pairs'); process.exit(1) }
if (TOL != null && maxGap > TOL) { console.error(`[parity] FAIL maxGap ${maxGap} > tol ${TOL}`); process.exit(1) }
