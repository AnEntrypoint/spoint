// scripts/ab-elevation.mjs -- A/B isolation of every ELEVATION term in the CPU height field.
// For each term, samples heightAt over a fibonacci sphere WITH the default uniforms vs WITH the term
// DISABLED, and reports max/mean |delta| + how many sample dirs it changes + the dir of max effect.
// A term whose max |delta| ~ 0 is a NO-OP (computed but never affects elevation) -- the thing to find.
// Specifically answers: do CANYONS actually affect the rendered elevation?  (npm run ab)

import { createHeightSampler } from '../src/height-cpu.js'

const N = Number(process.env.AB_N) || 20000
const radius = 6360000   // Earth-scale metres -> readable deltas; the field is scale-invariant

// term -> the uniform override that DISABLES/MINIMISES it. NOTE the guard `(x>0)?x:DEFAULT` on the
// octave + cliff uniforms (terrain.glsl:181/364) means 0 == "unset -> use default", so disabling means
// the NONZERO MINIMUM (1 octave; cliffAmt 0.01), not 0. canyonDepthMul also guards (0 -> floor depth 1,
// not zero) so its A/B shows depth-2 vs depth-1, still proving canyons carve.
const TERMS = [
  ['canyon-depth',      { canyonDepthMul: 0 }],     // guard -> floor 60*1 vs default 60*2: shallower canyons
  ['detail-overlay',    { uDetailOverlay: 0 }],     // detailFbm elevation add + flat-area valleys (default 6.0)
  ['cliff-terrace',     { cliffAmt: 0.01 }],        // ~off (guard blocks 0); vs default 1.0
  ['peak-octaves',      { uPeakOcts: 1 }],          // 1 vs default 3 octaves
  ['broadlow-octaves',  { uBroadLowOcts: 1 }],      // 1 vs default 8 octaves
  ['incise-ridge-oct',  { uInciseRidgeOcts: 1 }],   // 1 vs default 4 octaves
  ['detailfbm-octaves', { uDetailFbmOcts: 1 }],     // 1 vs default 3 octaves
  ['octmax-1',          { uOctMax: 1 }],            // clamp the whole broadShapeM loop to 1 octave (default 12)
  ['land-bias',         { uLandBias: 300 }],        // OFF by default (0) -> turning ON should shift land up
  ['climate-relief',    { uClimateRelief: 1 }],     // OFF by default (0) -> widens the flat-climate relief gates
]

const base = createHeightSampler({ radius })
const dirs = []
for (let i = 0; i < N; i++) {
  const y = 1 - (i + 0.5) / N * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const th = i * 2.399963229728653
  dirs.push([r * Math.cos(th), y, r * Math.sin(th)])
}
const baseH = dirs.map(d => base.heightAt(d))

console.log(`A/B elevation isolation -- ${N} dirs, radius ${radius}m\n`)
console.log('term'.padEnd(20), 'maxDelta'.padStart(10), 'meanDelta'.padStart(10), 'changedFrac'.padStart(12), '  verdict')
console.log('-'.repeat(72))
const results = []
for (const [name, override] of TERMS) {
  const s = createHeightSampler({ radius, uniforms: override })
  let maxD = 0, sum = 0, changed = 0, maxDir = null
  for (let i = 0; i < N; i++) {
    const d = Math.abs(baseH[i] - s.heightAt(dirs[i]))
    sum += d
    if (d > 1.0) changed++
    if (d > maxD) { maxD = d; maxDir = dirs[i] }
  }
  const frac = changed / N
  const verdict = maxD < 1.0 ? 'NO-OP (no elevation effect!)' : (frac < 0.001 ? 'rare (works, few sites)' : 'works')
  results.push({ name, maxD, meanD: sum / N, frac, verdict, maxDir })
  console.log(name.padEnd(20), maxD.toFixed(1).padStart(10), (sum / N).toFixed(2).padStart(10),
    (frac * 100).toFixed(2).padStart(11) + '%', '  ' + verdict)
}
const noops = results.filter(r => r.maxD < 1.0)
console.log('\n' + (noops.length ? 'NO-OP TERMS: ' + noops.map(r => r.name).join(', ') : 'every term affects elevation.'))
const canyon = results.find(r => r.name === 'canyon-depth')
console.log(`\nCANYONS affect elevation: ${canyon.maxD >= 1.0 ? 'YES' : 'NO'} (max ${canyon.maxD.toFixed(0)}m at ${canyon.maxDir ? '[' + canyon.maxDir.map(x => x.toFixed(3)).join(',') + ']' : 'n/a'}, ${(canyon.frac * 100).toFixed(2)}% of dirs).`)
