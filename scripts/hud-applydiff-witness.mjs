#!/usr/bin/env node
// Witness for the HUD frame diff. Counts real DOM mutations per HUD tick and measures
// the per-tick cost of the real webjsx applyDiff that client/AppModuleSystem.js
// renderAppUI drives. Arm A drives the real module; arm B drives a realistic 89-node
// HUD vdom with a one-field change per tick.
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement, applyDiff } from 'webjsx'
import { flagNumber } from './lib/witness-args.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const ARGV = process.argv.slice(2)
function flag(name, dflt) {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const FRAMES = flagNumber(flag, 'frames', 600, ARGV)
const APPS = flagNumber(flag, 'apps', 6, ARGV)
const SHOW_STATS = flag('stats', 'true') === 'true'
const INSTRUMENT = flag('instrument', 'on') === 'on'
const TAG = '[hud-applydiff]'

const counters = { creates: 0, adds: 0, removes: 0, attrWrites: 0, textWrites: 0 }
function reset() { for (const k of Object.keys(counters)) counters[k] = 0 }
function snapshot() { return { ...counters } }

class ShimNode {
  constructor() {
    this._parent = null
    this._prev = null
    this._next = null
    this._children = []
  }
  get parentNode() { return this._parent }
  get firstChild() { return this._children.length ? this._children[0] : null }
  get lastChild() { return this._children.length ? this._children[this._children.length - 1] : null }
  get nextSibling() { return this._next }
  get previousSibling() { return this._prev }
  get childNodes() { return this._children.slice() }
  appendChild(n) { return this._insertAt(n, this._children.length) }
  prepend(n) { return this._insertAt(n, 0) }
  insertBefore(n, ref) {
    const i = ref ? this._children.indexOf(ref) : this._children.length
    return this._insertAt(n, i < 0 ? this._children.length : i)
  }
  removeChild(n) {
    const i = this._children.indexOf(n)
    if (i < 0) throw new Error(`${TAG} removeChild on a node that is not a child`)
    this._children.splice(i, 1)
    this._relink()
    n._parent = null
    counters.removes++
    return n
  }
  replaceChild(next, old) {
    const i = this._children.indexOf(old)
    if (i < 0) throw new Error(`${TAG} replaceChild on a node that is not a child`)
    this._children[i] = next
    old._parent = null
    next._parent = this
    this._relink()
    counters.removes++
    counters.adds++
    return old
  }
  _insertAt(n, i) {
    if (n._parent) n._parent.removeChild(n)
    this._children.splice(i, 0, n)
    n._parent = this
    this._relink()
    counters.adds++
    return n
  }
  _relink() {
    for (let i = 0; i < this._children.length; i++) {
      const c = this._children[i]
      c._prev = i > 0 ? this._children[i - 1] : null
      c._next = i < this._children.length - 1 ? this._children[i + 1] : null
    }
  }
}

class ShimText extends ShimNode {
  constructor(text) { super(); this.nodeType = 3; this._text = String(text) }
  get data() { return this._text }
  get textContent() { return this._text }
  set textContent(v) { this._text = String(v) }
}

class ShimElement extends ShimNode {
  constructor(tagName) {
    super()
    this.nodeType = 1
    this.tagName = String(tagName).toUpperCase()
    this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    this._attrs = new Map()
    this._id = ''
    this._className = ''
    this._style = {}
  }
  get id() { return this._id }
  set id(v) { this._id = String(v) }
  get className() { return this._className }
  set className(v) { this._className = String(v) }
  get style() { return this._style }
  set style(v) { this._style = v }
  setAttribute(k, v) { this._attrs.set(String(k), String(v)); counters.attrWrites++ }
  removeAttribute(k) { this._attrs.delete(String(k)) }
  getAttribute(k) { return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null }
  hasAttribute(k) { return this._attrs.has(String(k)) }
  addEventListener() {}
  removeEventListener() {}
  get innerHTML() { throw new Error(`${TAG} innerHTML read is not modelled`) }
  set innerHTML(v) {
    if (v !== '') throw new Error(`${TAG} innerHTML write of non-empty markup is not modelled`)
    for (const c of this._children.splice(0)) { c._parent = null; counters.removes++ }
    this._relink()
  }
  get textContent() { return this._children.map((c) => c.textContent).join('') }
  set textContent(v) {
    for (const c of this._children.splice(0)) { c._parent = null; counters.removes++ }
    this._relink()
    if (v !== '') this.appendChild(document.createTextNode(v))
  }
}

function instrument(node) {
  return new Proxy(node, {
    set(target, key, value) {
      const internal = typeof key === 'string' && (key.startsWith('__') || key.startsWith('_'))
      if (!internal) {
        if (key === 'textContent') counters.textWrites++
        else counters.attrWrites++
      }
      target[key] = value
      return true
    },
  })
}

globalThis.Node = ShimNode
globalThis.Element = ShimElement
globalThis.HTMLElement = ShimElement
globalThis.document = {
  createElement(tag) {
    counters.creates++
    const el = new ShimElement(tag)
    return INSTRUMENT ? instrument(el) : el
  },
  createElementNS(_ns, tag) {
    counters.creates++
    const el = new ShimElement(tag)
    return INSTRUMENT ? instrument(el) : el
  },
  createTextNode(text) {
    counters.creates++
    const t = new ShimText(text)
    return INSTRUMENT ? instrument(t) : t
  },
}

function countNodes(node) {
  let n = 1
  for (const c of node._children) n += countNodes(c)
  return n
}

function appFragment(i) {
  return createElement('div', { 'data-app': `e${i}`, style: 'pointer-events:auto' },
    createElement('div', { class: 'app-title' }, `app ${i}`),
    createElement('div', { class: 'app-body' },
      createElement('span', { class: 'k' }, 'hp'),
      createElement('span', { class: 'v' }, '100'),
      createElement('span', { class: 'k' }, 'ammo'),
      createElement('span', { class: 'v' }, '30')))
}

function hudVdom(tick, apps = APPS) {
  const statsPanel = SHOW_STATS
    ? createElement('div', { id: 'runtime-panel' },
        createElement('div', { class: 'runtime-title' }, 'RUNTIME'),
        createElement('div', { class: 'runtime-row' }, 'FPS 60  |  16.70ms avg  |  31.20ms peak'),
        createElement('div', { class: 'runtime-spark-frame', style: 'height:20px' }),
        createElement('div', { class: 'runtime-row' }, 'DRAW 412  |  TRIS 1200000'),
        createElement('div', { class: 'runtime-row' }, `PLAYERS 8  |  ENTITIES 12  |  TICK ${tick}`),
        createElement('div', { class: 'runtime-row' }, 'RTT 24ms  |  BUF 3'),
        createElement('div', { class: 'runtime-spark-rtt', style: 'height:20px' }),
        createElement('div', { class: 'runtime-row' }, 'CULL 10/40  |  FAILOPEN 0  |  ANOMALY 0'))
    : null
  const fragments = []
  for (let i = 0; i < apps; i++) fragments.push(appFragment(i))
  return createElement('div', { id: 'hud' },
    SHOW_STATS ? null : createElement('div', { id: 'info' }, `FPS: 60 | Players: 8 | Tick: ${tick} | RTT: 24ms | Buf: 3`),
    statsPanel,
    ...fragments)
}

const failures = []
function expect(cond, msg) { if (!cond) failures.push(msg) }

function perFrame(c, n = FRAMES) {
  return {
    removes: Number((c.removes / n).toFixed(4)),
    adds: Number((c.adds / n).toFixed(4)),
    attrWrites: Number((c.attrWrites / n).toFixed(4)),
    textWrites: Number((c.textWrites / n).toFixed(4)),
    mutations: Number(((c.removes + c.adds + c.attrWrites + c.textWrites) / n).toFixed(4)),
  }
}

function check(label, pf) {
  expect(pf.removes === 0, `${label}: unchanged subtrees removed ${pf.removes} node(s) per tick, expected 0`)
  expect(pf.adds === 0, `${label}: unchanged subtrees added ${pf.adds} node(s) per tick, expected 0`)
  expect(pf.attrWrites === 0, `${label}: unchanged attributes wrote ${pf.attrWrites} attribute(s) per tick, expected 0`)
  expect(pf.textWrites <= 1, `${label}: a one-field change wrote ${pf.textWrites} text node(s) per tick, expected at most 1`)
}

// Arm A: the real production path, client/AppModuleSystem.js renderAppUI.
const { createAppModuleSystem } = await import(pathToFileURL(resolve(REPO_ROOT, 'client', 'AppModuleSystem.js')).href)
const uiRoot = document.createElement('div')
const ams = createAppModuleSystem(null, uiRoot)
const container = uiRoot._children[0]
const state = { entities: [], players: [1, 2, 3, 4, 5, 6, 7, 8] }
const engineCtx = { client: { playerId: 1, currentTick: 0, getRTT: () => 24, getBufferHealth: () => 3 }, entityAppMap: new Map() }

reset()
ams.renderAppUI(state, engineCtx, null, null, null, '60', null)
const armAFirst = snapshot()
const armANodes = countNodes(container)
reset()
const aStart = performance.now()
for (let f = 1; f <= FRAMES; f++) {
  engineCtx.client.currentTick = f
  ams.renderAppUI(state, engineCtx, null, null, null, `${60 - (f % 2)}`, null)
}
const armAMs = (performance.now() - aStart) / FRAMES
const armA = { nodes: armANodes, firstPass: armAFirst, perTick: perFrame(snapshot()), msPerTick: Number(armAMs.toFixed(5)) }
check('armA', armA.perTick)
expect(armANodes >= 3, `armA: real renderAppUI mounted only ${armANodes} node(s)`)

// Arm B: a realistic HUD vdom with app fragments, one field changed per tick.
const mount = document.createElement('div')
reset()
const bFirst = performance.now()
applyDiff(mount, hudVdom(0))
const armBFirstMs = performance.now() - bFirst
const armBFirst = snapshot()
const armBNodes = countNodes(mount)
reset()
let buildMs = 0
let diffMs = 0
for (let f = 1; f <= FRAMES; f++) {
  const t0 = performance.now()
  const vdom = hudVdom(f)
  const t1 = performance.now()
  applyDiff(mount, vdom)
  const t2 = performance.now()
  buildMs += t1 - t0
  diffMs += t2 - t1
}
const armB = {
  nodes: armBNodes,
  firstPass: armBFirst,
  perTick: perFrame(snapshot()),
  ms: {
    firstDiff: Number(armBFirstMs.toFixed(4)),
    vdomBuildPerTick: Number((buildMs / FRAMES).toFixed(5)),
    diffPerTick: Number((diffMs / FRAMES).toFixed(5)),
  },
}
check('armB', armB.perTick)
expect(armBNodes > 20, `armB: HUD vdom mounted only ${armBNodes} node(s), too small to be realistic`)

// Arm C: the control. The row's premise -- tear every child down and rebuild the whole
// HUD -- rendered on the same instrumented shim over the same vdom. It prices the premise
// and proves the instrument can SEE a full replacement at this population.
function isVElementObject(v) { return !!v && typeof v === 'object' && typeof v.tagName === 'string' }
function countVNodes(v) {
  if (isVElementObject(v)) return 1 + (v.props.children || []).reduce((n, c) => n + countVNodes(c), 0)
  return v === null || v === undefined || v === false ? 0 : 1
}
function buildFresh(vnode) {
  if (isVElementObject(vnode)) {
    const el = document.createElement(vnode.type)
    for (const [k, v] of Object.entries(vnode.props)) {
      if (k === 'children' || k === 'key' || k === 'ref' || k === 'dangerouslySetInnerHTML') continue
      if (v === null || v === undefined || v === false) continue
      el.setAttribute(k, String(v))
    }
    for (const child of vnode.props.children || []) el.appendChild(buildFresh(child))
    return el
  }
  return document.createTextNode(String(vnode))
}
function teardown(node) {
  for (const child of node.childNodes) { teardown(child); node.removeChild(child) }
}
function fullReplace(parent, vnode) {
  teardown(parent)
  parent.appendChild(buildFresh(vnode))
}
const controlMount = document.createElement('div')
fullReplace(controlMount, hudVdom(0))
const armCNodes = countNodes(controlMount)
reset()
const cStart = performance.now()
for (let f = 1; f <= FRAMES; f++) fullReplace(controlMount, hudVdom(f))
const armCMs = (performance.now() - cStart) / FRAMES
const armC = { nodes: armCNodes, perTick: perFrame(snapshot()), msPerTick: Number(armCMs.toFixed(5)) }
expect(armC.perTick.removes >= 20, `armC: the control teardown removed only ${armC.perTick.removes} node(s)/tick, so this instrument cannot see a teardown`)
expect(armC.perTick.adds >= 20, `armC: the control rebuild added only ${armC.perTick.adds} node(s)/tick, so this instrument cannot see a rebuild`)
expect(armC.perTick.mutations >= 50 * Math.max(armB.perTick.mutations, 1), `armC: a full replacement costs ${armC.perTick.mutations} mutation(s)/tick against ${armB.perTick.mutations} for the real diff -- too close to tell the two apart`)

// Arm D: a structural change -- one more HUD fragment per tick. Everything that was
// already mounted must survive untouched; only the new fragment may be added.
const APP_VNODES = countVNodes(appFragment(0))
const GROW_TICKS = Math.min(FRAMES, 40)
const growthMount = document.createElement('div')
applyDiff(growthMount, hudVdom(0, APPS))
const armDNodesBefore = countNodes(growthMount)
reset()
let growMs = 0
for (let f = 1; f <= GROW_TICKS; f++) {
  const vdom = hudVdom(f, APPS + f)
  const t0 = performance.now()
  applyDiff(growthMount, vdom)
  growMs += performance.now() - t0
}
const armD = {
  ticks: GROW_TICKS,
  appVNodes: APP_VNODES,
  nodesBefore: armDNodesBefore,
  nodesAfter: countNodes(growthMount),
  perTick: perFrame(snapshot(), GROW_TICKS),
  msPerTick: Number((growMs / GROW_TICKS).toFixed(5)),
}
expect(armD.perTick.removes === 0, `armD: growing the HUD by one fragment removed ${armD.perTick.removes} node(s)/tick, expected 0`)
expect(armD.perTick.adds > 0, `armD: growing the HUD by one fragment added ${armD.perTick.adds} node(s)/tick, so the new fragment was never mounted`)
expect(armD.perTick.adds <= 2 * APP_VNODES, `armD: growing by one ${APP_VNODES}-node fragment added ${armD.perTick.adds} node(s)/tick -- that is a rebuild, not a diff`)
expect(armD.perTick.adds < armDNodesBefore, `armD: ${armD.perTick.adds} node(s)/tick against a ${armDNodesBefore}-node HUD -- the whole tree is being rebuilt`)

// Arm E: source-derived. The row says "every frame"; client/app.js gates the single
// renderAppUI call site behind a 0.25 s accumulator, so the HUD is a 4 Hz diff.
const appSrc = readFileSync(resolve(REPO_ROOT, 'client', 'app.js'), 'utf8')
const callSites = appSrc.split('renderAppUI(').length - 1
const gateAt = appSrc.indexOf('ams.renderAppUI(')
const gateWindow = gateAt < 0 ? '' : appSrc.slice(Math.max(0, gateAt - 400), gateAt)
const gateMatch = /uiTimer\s*>=\s*([0-9.]+)/.exec(gateWindow)
const gateSeconds = gateMatch ? Number(gateMatch[1]) : null
const armE = { callSites, gateSeconds, hz: gateSeconds ? Number((1 / gateSeconds).toFixed(2)) : null }
expect(gateAt >= 0, 'gate: client/app.js no longer calls ams.renderAppUI(')
expect(callSites === 1, `gate: client/app.js names renderAppUI ${callSites} time(s), expected exactly 1`)
expect(gateSeconds !== null, 'gate: the HUD diff is not gated on uiTimer, so it renders every frame')
expect(/uiTimer\s*=\s*0/.test(gateWindow), 'gate: the HUD gate never resets uiTimer, so the accumulator never re-arms')
expect(armE.hz !== null && armE.hz <= 8, `gate: the HUD renders at ${armE.hz} Hz, which is a per-frame HUD, not the 4 Hz gate`)

console.log(`${TAG} armA ${JSON.stringify(armA)}`)
console.log(`${TAG} armB ${JSON.stringify(armB)}`)
console.log(`${TAG} armC ${JSON.stringify(armC)}`)
console.log(`${TAG} armD ${JSON.stringify(armD)}`)
console.log(`${TAG} gate ${JSON.stringify(armE)}`)
if (failures.length) {
  for (const f of failures) console.error(`${TAG} assertion failed: ${f}`)
  console.error(`${TAG} RESULT: FAIL (${failures.length} failure(s))`)
  process.exit(1)
}
console.log(`${TAG} RESULT: PASS ${FRAMES} tick(s) over ${armB.nodes} node(s): ${armB.perTick.mutations} mutation(s)/tick, ${armB.ms.diffPerTick} ms diff/tick, full-replace control ${armC.perTick.mutations} mutation(s)/tick`)
process.exit(0)
