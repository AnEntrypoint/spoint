#!/usr/bin/env node
// Counts the per-pixel work units of the mapspinner sky background node: exp operations and
// atmosphere LUT fetches. It builds the REAL node graph in node (no adapter, no browser) by
// running the sky's own Fn body against the real TSL module, then walks that graph.
//
// Non-vacuity in both directions: the shipped source is counted, then a variant that restores the
// two marches this node used to run is counted and has to come back to the original numbers, and a
// variant with every march removed has to come back to zero. A counter that printed the same figure
// for all three, or zero for all three, fails here instead of reading as a measurement.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LABEL = 'sky-single-march-count'
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.resolve(HERE, '..')
const REAL = path.join(ROOT, 'packages', 'mapspinner', 'src', 'tsl', 'sky-tsl.js')
const SCRATCH = path.join(ROOT, '.gm', 'tmp', 'sky-ap-variants')

const fail = []
const check = (name, got, want) => {
  const ok = got === want
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}: got=${got} want=${want}`)
  if (!ok) fail.push(`${name} got=${got} want=${want}`)
}

fs.rmSync(SCRATCH, { recursive: true, force: true })
fs.mkdirSync(SCRATCH, { recursive: true })

const TSL = await import('three/tsl')

// TextureNode is emitted twice per sampled LUT tap: texture() and its .level()/.depth() twin.
const TEX_NODES_PER_FETCH = 2

const childrenOf = (n) => {
  const out = []
  for (const k of Object.keys(n)) {
    const v = n[k]
    if (Array.isArray(v)) { for (const e of v) if (e && e.isNode) out.push(e) } else if (v && typeof v === 'object' && v.isNode) out.push(v)
  }
  return out
}

// A node's type is only known once built, so read the width off the first typed leaf in its
// operand subgraph: a ConstNode carrying a Vector, or a JoinNode's arity.
const SCALAR_MATH = new Set(['length', 'dot', 'distance', 'luminance'])

function operandWidth(root) {
  const seen = new Set()
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n !== 'object' || !n.isNode || seen.has(n)) continue
    seen.add(n)
    const name = n.constructor ? n.constructor.name : ''
    if (name === 'MathNode' && SCALAR_MATH.has(n.method)) return 1
    if (name === 'JoinNode') return Math.max(1, (n.params || []).length)
    const v = n.value
    if (v && typeof v === 'object') {
      if (v.isVector4) return 4
      if (v.isVector3 || v.isColor) return 3
      if (v.isVector2) return 2
    }
    const kids = childrenOf(n)
    if (kids.length) stack.push(kids[0])
  }
  return 1
}

function countGraph(root, extra) {
  const seen = new Set()
  let expNodes = 0
  let expOps = 0
  let expVec3 = 0
  let texNodes = 0
  const stack = [root, ...extra]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n !== 'object' || !n.isNode || seen.has(n)) continue
    seen.add(n)
    const name = n.constructor ? n.constructor.name : ''
    if (name === 'MathNode' && n.method === 'exp') {
      expNodes++
      const w = operandWidth(n.aNode)
      if (w > 1) expVec3++
      expOps += w
    } else if (name === 'TextureNode') {
      texNodes++
    }
    for (const c of childrenOf(n)) stack.push(c)
  }
  return { expNodes, expOps, expVec3, fetches: texNodes / TEX_NODES_PER_FETCH, texNodes, nodes: seen.size }
}

async function countSky(srcPath) {
  const mod = await import(pathToFileURL(srcPath).href)
  const sky = mod.createSkyTSL({ radius: 63600, luts: null })
  const call = sky.node.node ? sky.node.node : sky.node
  const extra = []
  const prev = TSL.getCurrentStack()
  // The body assigns into vars; outside a builder there is no stack, so hand it one that only
  // records, which is enough for every node the body builds to stay reachable.
  TSL.setCurrentStack({ addToStack(n) { extra.push(n); return n }, assign(t, v) { extra.push(v); return t } })
  let out
  try { out = call.shaderNode.jsFunc() } finally { TSL.setCurrentStack(prev) }
  return countGraph(out, extra)
}

const variant = (name, edits) => {
  const src = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n')
  let out = src
  for (const [from, to] of edits) {
    if (!out.includes(from)) throw new Error(`${LABEL}: variant ${name} anchor not found: ${from}`)
    out = out.replace(from, to)
  }
  out = out.replace(/from '\.\.\/([^']+)'/g, (m, p) => `from '${pathToFileURL(path.join(ROOT, 'packages', 'mapspinner', 'src', p)).href}'`)
  out = out.replace(/from '\.\/([^']+)'/g, (m, p) => `from '${pathToFileURL(path.join(ROOT, 'packages', 'mapspinner', 'src', 'tsl', p)).href}'`)
  const dest = path.join(SCRATCH, name)
  fs.writeFileSync(dest, out)
  return dest
}

// The shipped background node: one march whose end distance is selected by wSky instead of two
// marches whose results are blended by it.
const SINGLE_BLOCK = [
  '    const wSky = smoothstep(muTangent.sub(ATM_HORIZON_BLEND_MU), muTangent.add(ATM_HORIZON_BLEND_MU), mu)',
  '    const dEnd = mix(max(distToGround(r, mu), 1e-3), distToTop(r, mu), wSky)',
  '    const marched = marchSteps(camera, ray, sun, dEnd)',
  '    const skyVisible = distToTop(r, mu).greaterThan(0.0).and(rIn.lessThanEqual(ATM_TOP).or(dtIn.greaterThanEqual(0.0)))',
  '    const radianceBase = select(skyVisible, marched.radiance, vec3(0.0))',
  '    const trans = select(skyVisible, mix(vec3(0.0), marched.trans, wSky), vec3(1.0))',
].join('\n')

// The node as it shipped before this row: two unconditional marches, mixed.
const TWO_MARCH_BLOCK = [
  '    const wSky = smoothstep(muTangent.sub(ATM_HORIZON_BLEND_MU), muTangent.add(ATM_HORIZON_BLEND_MU), mu)',
  '    const sky = marchSteps(camera, ray, sun, distToTop(r, mu))',
  '    const ground = marchSteps(camera, ray, sun, max(distToGround(r, mu), 1e-3))',
  '    const skyVisible = distToTop(r, mu).greaterThan(0.0).and(rIn.lessThanEqual(ATM_TOP).or(dtIn.greaterThanEqual(0.0)))',
  '    const radianceBase = select(skyVisible, mix(ground.radiance, sky.radiance, wSky), vec3(0.0))',
  '    const trans = select(skyVisible, mix(vec3(0.0), sky.trans, wSky), vec3(1.0))',
].join('\n')

const real = fs.readFileSync(REAL, 'utf8').replace(/\r\n/g, '\n')
const nodeBody = (() => {
  const a = real.indexOf('const node = Fn(() => {')
  const b = real.indexOf('\n  })()', a)
  return a < 0 || b < 0 ? '' : real.slice(a, b)
})()
// The refuted predecessor row swapped marchSteps for marchRadiance, a different integrator. This row
// must not: one march, same march.
check('background node still integrates with marchSteps', /marchRadiance\(/.test(nodeBody), false)
check('background node no longer carries the second march', (nodeBody.match(/marchSteps\(/g) || []).length, 1)

const single = await countSky(REAL)
console.log(`MEASURED single-march: expNodes=${single.expNodes} expOps=${single.expOps} lutFetches=${single.fetches} graphNodes=${single.nodes}`)

const two = await countSky(variant('two-marches.js', [[SINGLE_BLOCK, TWO_MARCH_BLOCK]]))
console.log(`MEASURED two-marches-restored: expNodes=${two.expNodes} expOps=${two.expOps} lutFetches=${two.fetches}`)

const none = await countSky(variant('no-march.js', [
  ['    const marched = marchSteps(camera, ray, sun, dEnd)', '    const marched = { radiance: vec3(0.0), trans: vec3(1.0) }'],
]))
console.log(`MEASURED both-marches-removed: expNodes=${none.expNodes} expOps=${none.expOps} lutFetches=${none.fetches}`)

// One march: 8 unrolled steps of 2 scalar exp + 1 vec3 exp and one transmittance-LUT tap.
check('single march expOps/pixel', single.expOps, 40)
check('single march expNodes/pixel', single.expNodes, 24)
check('single march lutFetches/pixel', single.fetches, 8)

// Non-vacuous the other way: put the march back and the count returns to the original numbers.
check('two marches restored expOps/pixel', two.expOps, 80)
check('two marches restored expNodes/pixel', two.expNodes, 48)
check('two marches restored lutFetches/pixel', two.fetches, 16)

check('both marches removed zeroes expOps', none.expOps, 0)
check('both marches removed zeroes fetches', none.fetches, 0)

console.log(`RESULT: ${fail.length ? 'FAIL' : 'PASS'} label=${LABEL} single={exp:${single.expOps},lut:${single.fetches}} two-marches={exp:${two.expOps},lut:${two.fetches}}`)
if (fail.length) { console.log('FAILURES ' + JSON.stringify(fail)); process.exit(1) }
