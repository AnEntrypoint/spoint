#!/usr/bin/env node
// PERF-shadow-cascade-redraw-hitch-1013.
//
// client/core/ShadowPipeline.js forceUpdate(movers, eye) dirties only the cascades whose
// camera-distance band, widened by CASCADE_BLEND_M plus SHADOW_REDRAW_CASTER_HEIGHT_M/tan(sun
// elevation), contains a moved caster. What was never measured is what a cascade redraw costs per
// frame and whether it lands as a hitch while travelling.
//
// This witness measures the counted work unit that question turns on -- how many cascade shadow maps
// are re-rendered in one frame while the player travels -- by driving the shipped pipeline in node
// over a real travel path at several speeds, unbounded against shipped. It runs in the gpu-free arm
// of scripts/check.mjs because what it measures is the pipeline's own decision, not a pixel: the
// pipeline is pure geometry and snapping, so the frame it decides here is the frame the browser would
// decide. Whether a redraw the pipeline asks for costs frame time is a browser arm this CI does not
// run (scripts/shadow-cascade-hitch-browser-witness.mjs).
//
// The instrument is CPU wall: the decision loop is timed, not sampled, so every figure below is a
// measured elapsed time over the same path and the same frame count. No per-pass GPU figure appears
// anywhere in here: docs/measurement-figures.md s0 invalidated every one of them.
//
//   node scripts/shadow-cascade-redraw-witness.mjs
import * as THREE from 'three'
import { createShadowPipeline } from '../client/core/ShadowPipeline.js'

const LABEL = 'shadow-cascade-redraw'
const FRAMES = 3600
const DT = 1 / 60
const SPEEDS = [3, 6, 12, 20]
const MAP_SIZE = 1024
const EXTENT = 60
const EYE_BACK_M = 6
const EYE_UP_M = 2

const checks = []
function expect(label, got, ok) {
  checks.push({ label, got, ok: ok === true })
  return ok === true
}
const pctOf = (arr, p) => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y)
  if (!a.length) return null
  return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(4)
}
const dist = (arr) => ({ n: arr.length, p50: pctOf(arr.slice(), 0.5), p95: pctOf(arr.slice(), 0.95), max: arr.length ? +Math.max(...arr).toFixed(4) : null })

function makePipeline(cascadeCount, farRedrawBudget) {
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.castShadow = true
  sun.shadow.mapSize.set(MAP_SIZE, MAP_SIZE)
  const scene = new THREE.Scene()
  scene.add(sun)
  scene.add(sun.target)
  return createShadowPipeline(sun, { extent: EXTENT, cascades: cascadeCount, scene, farRedrawBudget })
}

function walkPath(frame, speed) {
  const t = frame * DT
  const arc = 0.05 * t
  return new THREE.Vector3(Math.sin(arc) * speed * t, 0, Math.cos(arc) * speed * t)
}

function runArm(cascadeCount, farRedrawBudget, speed) {
  const pipeline = makePipeline(cascadeCount, farRedrawBudget)
  const lights = pipeline.lights
  const caster = new THREE.Object3D()
  const perFrame = []
  const farPerFrame = []
  const perCascade = lights.map(() => 0)
  const cpuPerFrame = []
  let maxPending = 0
  let travelled = 0
  let prev = null

  const t0 = performance.now()
  for (let f = 0; f < FRAMES; f++) {
    const p = walkPath(f, speed)
    if (prev) travelled += p.distanceTo(prev)
    prev = p.clone()
    const frameStart = performance.now()
    caster.position.copy(p)
    caster.updateMatrixWorld(true)
    const eye = new THREE.Vector3(p.x, p.y + EYE_UP_M, p.z + EYE_BACK_M)
    pipeline.update(p)
    pipeline.forceUpdate([caster], eye)
    let redraws = 0
    let far = 0
    for (let i = 0; i < lights.length; i++) {
      if (!lights[i].shadow.needsUpdate) continue
      redraws++
      if (i > 0) far++
      perCascade[i]++
      lights[i].shadow.needsUpdate = false
    }
    cpuPerFrame.push(performance.now() - frameStart)
    for (const c of pipeline.debug().cascades) if (c.pendingFrames > maxPending) maxPending = c.pendingFrames
    // Frame 0 carries every cascade's construction-time needsUpdate, which is not a redraw the
    // pipeline decided, so it is excluded from the per-frame distribution.
    if (f > 0) { perFrame.push(redraws); farPerFrame.push(far) }
  }
  return {
    cascadeCount: lights.length,
    speed,
    travelledM: +travelled.toFixed(1),
    perCascade,
    cascade0: perCascade[0],
    farTotal: perCascade.slice(1).reduce((a, b) => a + b, 0),
    redrawsPerFrame: dist(perFrame),
    farPerFrame: dist(farPerFrame),
    framesWithAllThree: perFrame.filter((n) => n >= 3).length,
    maxPendingFrames: maxPending,
    cpuPerFrame: dist(cpuPerFrame),
    cpuTotalMs: +(performance.now() - t0).toFixed(2),
  }
}

const jsonLine = (o) => JSON.stringify(o)
const rows = SPEEDS.map((speed) => ({ speed, before: runArm(3, Infinity, speed), after: runArm(3, undefined, speed) }))
for (const { speed, before, after } of rows) {
  console.log(`[${LABEL}] ${speed} m/s over ${FRAMES} frame(s) of ${before.travelledM} m, unbounded ${jsonLine({
    perCascade: before.perCascade, farTotal: before.farTotal, redrawsPerFrame: before.redrawsPerFrame,
    farPerFrame: before.farPerFrame, framesWithAllThree: before.framesWithAllThree,
  })}`)
  console.log(`[${LABEL}] ${speed} m/s, shipped ${jsonLine({
    perCascade: after.perCascade, farTotal: after.farTotal, redrawsPerFrame: after.redrawsPerFrame,
    farPerFrame: after.farPerFrame, framesWithAllThree: after.framesWithAllThree,
    maxPendingFrames: after.maxPendingFrames,
  })}`)
  console.log(`[${LABEL}] A/B ${speed} m/s: redraw(s)/frame p50 ${before.redrawsPerFrame.p50} -> ${after.redrawsPerFrame.p50}, p95 ${before.redrawsPerFrame.p95} -> ${after.redrawsPerFrame.p95}, worst ${before.redrawsPerFrame.max} -> ${after.redrawsPerFrame.max}; frame(s) redrawing all 3 ${before.framesWithAllThree} -> ${after.framesWithAllThree}; far redraw(s) ${before.farTotal} -> ${after.farTotal}; cascade 0 ${before.cascade0} -> ${after.cascade0}; cpu p95 ${before.cpuPerFrame.p95} -> ${after.cpuPerFrame.p95} ms/frame, worst ${before.cpuPerFrame.max} -> ${after.cpuPerFrame.max} ms`)
}
const single = runArm(1, undefined, 6)
console.log(`[${LABEL}] arm single-cascade at 6 m/s ${jsonLine({
  cascadeCount: single.cascadeCount, perCascade: single.perCascade, redrawsPerFrame: single.redrawsPerFrame,
})}`)

for (const { speed, before, after } of rows) {
  expect(`${speed} m/s: unbounded does redraw all three cascades in one frame, so the arm is non-vacuous`,
    before.framesWithAllThree, before.framesWithAllThree > 0)
  expect(`${speed} m/s: shipped cut the frames that redraw all three`,
    after.framesWithAllThree < before.framesWithAllThree, after.framesWithAllThree < before.framesWithAllThree)
  expect(`${speed} m/s: the near cascade cadence is untouched`, after.cascade0 === before.cascade0, after.cascade0 === before.cascade0)
  expect(`${speed} m/s: the budget only ever removes work`, after.farTotal <= before.farTotal, after.farTotal <= before.farTotal)
  expect(`${speed} m/s: the budget removed work at this speed`, after.farTotal < before.farTotal, after.farTotal < before.farTotal)
  expect(`${speed} m/s: both far cascades still redraw, so none is starved`,
    Math.min(...after.perCascade.slice(1)), Math.min(...after.perCascade.slice(1)) > 0)
  expect(`${speed} m/s: no far cascade waits longer than the defer ceiling`,
    after.maxPendingFrames, after.maxPendingFrames <= 2)
}
const saved = rows.reduce((s, r) => s + (r.before.farTotal - r.after.farTotal), 0)
expect('the budget removes work across the ladder', saved, saved > 0)
expect('a lone cascade redraws one map per frame and is never band-selected at all',
  single.cascadeCount === 1 && single.redrawsPerFrame.max === 1, single.cascadeCount === 1 && single.redrawsPerFrame.max === 1)
expect('the redraw decision is not itself a frame-time cost: its p95 is under a millisecond',
  Math.max(...rows.map((r) => r.after.cpuPerFrame.p95)), Math.max(...rows.map((r) => r.after.cpuPerFrame.p95)) < 1)

const failed = checks.filter((c) => !c.ok)
for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)}`)
console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
// The residual all-three frames are the ones forceUpdate dirties on its own: it writes
// needsUpdate directly for a caster that entered a band, and the budget only gates update(). Those
// are the frames a caster actually moved into a far band, which is the invalidation the band filter
// exists for, so they are left alone.
console.log(`[${LABEL}] residual frame(s) redrawing all three come from forceUpdate's own dirtying plus the ${2}-frame defer ceiling, not from update()`)
const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
console.log(`RESULT: ${verdict} label=${LABEL} -- worst cascade redraw(s) in one frame while travelling ${rows.map((r) => `${r.speed}m/s:${r.before.redrawsPerFrame.max}->${r.after.redrawsPerFrame.max}`).join(' ')} (of 3); frame(s) redrawing all three ${rows.map((r) => `${r.speed}m/s:${r.before.framesWithAllThree}->${r.after.framesWithAllThree}`).join(' ')}; far redraw(s) ${rows.map((r) => `${r.speed}m/s:${r.before.farTotal}->${r.after.farTotal}`).join(' ')}; cascade 0 ${rows[0].after.cascade0}/${FRAMES} frame(s) unchanged; decision cpu wall p95 ${Math.max(...rows.map((r) => r.after.cpuPerFrame.p95))} ms/frame`)
process.exit(verdict === 'PASS' ? 0 : 1)
