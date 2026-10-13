#!/usr/bin/env node
// Counts the per-pixel work units of the mapspinner sky background node: exp operations and
// atmosphere LUT fetches. It builds the REAL node graph in node (no adapter, no browser) by
// running the sky's own Fn body against the real TSL module, then walks that graph.
//
// Non-vacuity: the same counter is run against three source variants written to a scratch dir --
// one march removed, both marches removed, and the proposed shared-LUT solve -- so a count that
// does not move when the marches are removed is a failure, not a measurement.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LABEL = 'sky-aerial-perspective-count'
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

const SKY_CALL = "const sky = marchSteps(camera, ray, sun, distToTop(r, mu))"
const GROUND_CALL = "const ground = marchSteps(camera, ray, sun, max(distToGround(r, mu), 1e-3))"

const before = await countSky(REAL)
console.log(`MEASURED before: expNodes=${before.expNodes} expOps=${before.expOps} lutFetches=${before.fetches} graphNodes=${before.nodes}`)

const oneMarch = await countSky(variant('one-march.js', [[GROUND_CALL, 'const ground = sky']]))
console.log(`MEASURED one-march-removed: expNodes=${oneMarch.expNodes} expOps=${oneMarch.expOps} lutFetches=${oneMarch.fetches}`)

const noMarch = await countSky(variant('no-march.js', [
  [SKY_CALL, 'const sky = { radiance: vec3(0.0), trans: vec3(1.0) }'],
  [GROUND_CALL, 'const ground = sky'],
]))
console.log(`MEASURED both-marches-removed: expNodes=${noMarch.expNodes} expOps=${noMarch.expOps} lutFetches=${noMarch.fetches}`)

// The proposed share: one scattering/transmittance solve for the camera, one tail solve for the
// ground end. Both branches derive from it, so nothing is integrated twice.
const SHARED = `    const muS = dot(camera, sun).div(r).toVar()
    const nu = dot(ray, sun).toVar()
    const dTop = distToTop(r, mu).toVar()
    const full = scattering(r, mu, muS).toVar()
    const tFull = transmittance(r, mu).toVar()
    const dGround = max(distToGround(r, mu), 1e-3).toVar()
    const pEnd = camera.add(ray.mul(dGround)).toVar()
    const rEnd = length(pEnd).toVar()
    const muEnd = dot(pEnd, ray).div(rEnd).toVar()
    const tail = scattering(rEnd, muEnd, dot(pEnd, sun).div(rEnd)).toVar()
    const tEnd = transmittance(rEnd, muEnd).toVar()
    const hasTail = dGround.lessThan(dTop.sub(1e-4))
    const tToEnd = tFull.div(max(tEnd, vec3(1e-6))).toVar()
    const gr = select(hasTail, max(full.rgb.sub(tToEnd.mul(tail.rgb)), vec3(0.0)), vec3(0.0)).toVar()
    const gm = select(hasTail, max(full.a.sub(dot(tToEnd, vec3(1 / 3)).mul(tail.a)), 0.0), 0.0).toVar()
    const phaseR = rayleigh.mul(rayleighPhase(nu))
    const phaseM = vec3(miePhase(nu).mul(ATM_MIE_SCAT))
    const sky = { radiance: solar.mul(full.rgb.mul(phaseR).add(full.a.mul(phaseM))), trans: tFull }
    const ground = { radiance: solar.mul(gr.mul(phaseR).add(gm.mul(phaseM))), trans: vec3(0.0) }`
const shared = await countSky(variant('shared.js', [
  [`    const sky = marchSteps(camera, ray, sun, distToTop(r, mu))\n    const ground = marchSteps(camera, ray, sun, max(distToGround(r, mu), 1e-3))`, SHARED],
]))
console.log(`MEASURED shared-solve: expNodes=${shared.expNodes} expOps=${shared.expOps} lutFetches=${shared.fetches}`)

// Baseline: the two marches are unconditional, 8 steps each, 2 scalar + 1 vec3 exp and one
// transmittance-LUT tap per step.
check('before expOps/pixel', before.expOps, 80)
check('before lutFetches/pixel', before.fetches, 16)
check('before expNodes/pixel', before.expNodes, 48)

// Non-vacuous in both directions: remove work and the count must fall, all of it and to zero.
check('one march removed halves expOps', oneMarch.expOps, 40)
check('one march removed halves fetches', oneMarch.fetches, 8)
check('both marches removed zeroes expOps', noMarch.expOps, 0)
check('both marches removed zeroes fetches', noMarch.fetches, 0)

// The shared solve integrates nothing: 6 LUT taps (2+1 for the camera, 2+1 for the ground tail).
check('shared solve expOps/pixel', shared.expOps, 0)
check('shared solve lutFetches/pixel', shared.fetches, 6)

console.log(`RESULT: ${fail.length ? 'FAIL' : 'PASS'} label=${LABEL} before={exp:${before.expOps},lut:${before.fetches}} shared={exp:${shared.expOps},lut:${shared.fetches}}`)
if (fail.length) { console.log('FAILURES ' + JSON.stringify(fail)); process.exit(1) }
