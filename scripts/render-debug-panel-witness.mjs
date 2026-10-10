#!/usr/bin/env node
// Witness for client/hud/RenderDebugPanel.js: node-only, stub document + window.
// Drives createRenderDebugPanel(uiRoot, renderControls): style injection, per-toggle get/set,
// the checkbox change event, destroy, and a scratch-mutant arm proving the checks have teeth.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PANEL_REL = 'client/hud/RenderDebugPanel.js'
const ARGV = process.argv.slice(2)
function flag(name, dflt = null) {
  const hit = ARGV.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const SOURCE_ARG = flag('source', null)
const PANEL_ABS = SOURCE_ARG ? resolve(SOURCE_ARG) : join(REPO_ROOT, PANEL_REL)
const PANEL_LABEL = SOURCE_ARG ? PANEL_ABS : PANEL_REL
const SELFCHECK = SOURCE_ARG === null
const TAG = '[render-debug-panel]'

const EXPECTED_LABELS = [
  'Sun shadow (hostShadowOff)',
  'SSAO',
  'Decal system (bullet holes/tracers)',
  'Grass decals (scorch/trample overlay)',
  'Shadow cascades: force to 1',
  'Player VAT crowd render',
]
const EXPECTED_INITIAL = [true, true, true, false, false, true]

function stubDocument() {
  const all = []
  function makeEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      _id: '',
      className: '',
      textContent: '',
      type: '',
      checked: false,
      children: [],
      parentNode: null,
      removed: false,
      listeners: new Map(),
      style: { cssText: '' },
      appendChild(child) {
        this.children.push(child)
        child.parentNode = this
        return child
      },
      addEventListener(type, fn) {
        const list = this.listeners.get(type)
        if (list) list.push(fn)
        else this.listeners.set(type, [fn])
      },
      remove() {
        this.removed = true
        const parent = this.parentNode
        if (parent) parent.children = parent.children.filter((c) => c !== this)
        this.parentNode = null
      },
      fire(type) {
        for (const fn of this.listeners.get(type) ?? []) fn()
      },
    }
    Object.defineProperty(el, 'id', {
      get() { return el._id },
      set(v) { el._id = String(v) },
    })
    all.push(el)
    return el
  }
  const head = makeEl('head')
  const body = makeEl('body')
  return {
    head,
    body,
    all,
    createElement: makeEl,
    createTextNode(text) {
      const node = { nodeType: 3, textContent: String(text), children: [] }
      all.push(node)
      return node
    },
    getElementById(id) {
      for (const el of all) if (el._id === id) return el
      return null
    },
  }
}

function stubWindow() {
  return {
    __hostShadowOff: false,
    __decalsOff: false,
    __grassDecalsOff: true,
    __playerVatOff: false,
    __shadowPipeline: {
      cascadeCount: 4,
      lights: [{ castShadow: true }, { castShadow: true }, { castShadow: true }, { castShadow: true }],
    },
    __app: {
      decals: { _pool: [{ mesh: { visible: true } }, { mesh: { visible: true } }] },
    },
  }
}

function stubRenderControls() {
  const values = new Map([['ssao', true]])
  const calls = []
  return {
    values,
    calls,
    get(key) { return values.get(key) ?? null },
    set(key, value) { values.set(key, value); calls.push([key, value]) },
  }
}

async function drivePanel(moduleUrl) {
  const doc = stubDocument()
  const win = stubWindow()
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
  const oldDocument = globalThis.document
  const oldWindow = globalThis.window
  globalThis.document = doc
  globalThis.window = win

  const failures = []
  const facts = { checks: 0, toggles: 0, sets: 0, listeners: 0 }
  const expect = (cond, msg) => {
    facts.checks += 1
    if (cond) return
    failures.push(msg)
    console.error(`${TAG} assertion failed: ${msg}`)
  }

  try {
    const mod = await import(moduleUrl)
    const createRenderDebugPanel = mod.createRenderDebugPanel
    expect(typeof createRenderDebugPanel === 'function', `${PANEL_LABEL} exports no createRenderDebugPanel function (got ${typeof createRenderDebugPanel})`)

    const uiRoot = doc.createElement('div')
    const rc = stubRenderControls()
    const panel = createRenderDebugPanel(uiRoot, rc)

    const styleEl = doc.getElementById('render-debug-panel-style')
    expect(styleEl !== null, 'ensureStyle appended no element carrying id render-debug-panel-style, so the panel ships unstyled')
    expect(styleEl !== null && doc.head.children.includes(styleEl), 'the style element is not a child of document.head')
    expect(styleEl !== null && styleEl.textContent.includes('.rdp-card'), `the injected style carries no .rdp-card rule (textContent=${JSON.stringify(styleEl ? styleEl.textContent.slice(0, 40) : null)})`)
    expect(styleEl !== null && styleEl.tagName === 'STYLE', `the injected style element is a ${styleEl ? styleEl.tagName : 'null'}, not a STYLE`)

    expect(uiRoot.children.length === 1, `createRenderDebugPanel appended ${uiRoot.children.length} child(ren) to uiRoot, expected exactly 1 card`)
    const card = uiRoot.children[0]
    expect(panel && panel.node === card, 'panel.node is not the card appended to uiRoot')
    expect(card && card.className === 'rdp-card', `the card className is ${JSON.stringify(card ? card.className : null)}, not rdp-card`)

    const title = card && card.children[0]
    expect(title && title.className === 'rdp-h' && title.textContent === 'Render Debug Toggles', `the card's first child is not the "Render Debug Toggles" header (got ${JSON.stringify(title ? title.textContent : null)})`)
    const hint = card && card.children[1]
    expect(hint && typeof hint.textContent === 'string' && hint.textContent.startsWith('Uncheck'), `the card's second child is not the hint line (got ${JSON.stringify(hint ? hint.textContent : null)})`)

    const labels = card ? card.children.slice(2) : []
    expect(labels.length === EXPECTED_LABELS.length, `the panel built ${labels.length} toggle row(s), expected ${EXPECTED_LABELS.length}`)
    const inputs = []
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i]
      const input = label.children[0]
      const text = label.children[1]
      inputs.push(input)
      expect(input && input.tagName === 'INPUT' && input.type === 'checkbox', `row ${i} holds no checkbox input (got ${JSON.stringify(input ? input.tagName + '/' + input.type : null)})`)
      expect(text && text.textContent === EXPECTED_LABELS[i], `row ${i} label text is ${JSON.stringify(text ? text.textContent : null)}, expected ${JSON.stringify(EXPECTED_LABELS[i])}`)
      const handlers = input ? (input.listeners.get('change') ?? []) : []
      expect(handlers.length === 1, `row ${i} checkbox carries ${handlers.length} change listener(s), expected 1`)
      facts.listeners += handlers.length
    }

    const initial = inputs.map((el) => el.checked)
    expect(JSON.stringify(initial) === JSON.stringify(EXPECTED_INITIAL), `initial checkbox state ${JSON.stringify(initial)} is not ${JSON.stringify(EXPECTED_INITIAL)}, so get() is not what fills the checkboxes`)

    const set = (i, on) => { inputs[i].checked = on; inputs[i].fire('change'); facts.sets += 1; facts.toggles += 1 }

    set(0, false)
    expect(win.__hostShadowOff === true, `unchecking "Sun shadow" left window.__hostShadowOff=${win.__hostShadowOff}, expected true`)
    set(0, true)
    expect(win.__hostShadowOff === false, `checking "Sun shadow" left window.__hostShadowOff=${win.__hostShadowOff}, expected false`)

    set(1, false)
    expect(rc.get('ssao') === false, `unchecking SSAO left renderControls ssao=${JSON.stringify(rc.get('ssao'))}, expected false`)
    expect(rc.calls.length === 1 && rc.calls[0][0] === 'ssao' && rc.calls[0][1] === false, `SSAO wrote ${JSON.stringify(rc.calls)} to renderControls, expected [["ssao",false]]`)
    set(1, true)
    expect(rc.get('ssao') === true, `checking SSAO left renderControls ssao=${JSON.stringify(rc.get('ssao'))}, expected true`)
    expect(rc.calls.length === 2, `renderControls.set fired ${rc.calls.length} time(s) over two SSAO changes, expected 2`)

    set(2, false)
    expect(win.__decalsOff === true, `unchecking decals left window.__decalsOff=${win.__decalsOff}, expected true`)
    const poolVisible = win.__app.decals._pool.map((d) => d.mesh.visible)
    expect(poolVisible.every((v) => v === false), `unchecking decals left the decal pool meshes at visible=${JSON.stringify(poolVisible)}, expected all false`)
    set(2, true)
    expect(win.__decalsOff === false, `checking decals left window.__decalsOff=${win.__decalsOff}, expected false`)
    const poolAfter = win.__app.decals._pool.map((d) => d.mesh.visible)
    expect(poolAfter.every((v) => v === false), `re-checking decals restored pool meshes to visible=${JSON.stringify(poolAfter)}; the on && mesh.visible write cannot restore, so expected all false`)

    set(3, true)
    expect(win.__grassDecalsOff === false, `checking grass decals left window.__grassDecalsOff=${win.__grassDecalsOff}, expected false`)
    set(3, false)
    expect(win.__grassDecalsOff === true, `unchecking grass decals left window.__grassDecalsOff=${win.__grassDecalsOff}, expected true`)

    const lights = win.__shadowPipeline.lights
    set(4, false)
    expect(lights.every((l) => l.castShadow === true), `the shadow-cascade toggle acted on set(false), which returns early: castShadow=${JSON.stringify(lights.map((l) => l.castShadow))}, expected all true`)
    set(4, true)
    expect(lights[0].castShadow === true, `forcing one cascade cleared lights[0].castShadow, but lights[0] is the sun cascade and must stay on`)
    expect(lights.slice(1).every((l) => l.castShadow === false), `forcing one cascade left castShadow=${JSON.stringify(lights.map((l) => l.castShadow))}, expected only lights[0] true`)

    set(5, false)
    expect(win.__playerVatOff === true, `unchecking the VAT crowd toggle left window.__playerVatOff=${win.__playerVatOff}, expected true`)
    set(5, true)
    expect(win.__playerVatOff === false, `checking the VAT crowd toggle left window.__playerVatOff=${win.__playerVatOff}, expected false`)

    const uiRoot2 = doc.createElement('div')
    createRenderDebugPanel(uiRoot2, stubRenderControls())
    const styles = doc.head.children.filter((el) => el._id === 'render-debug-panel-style')
    expect(styles.length === 1, `a second panel appended ${styles.length} style element(s) to head; ensureStyle must stay idempotent`)
    expect(uiRoot2.children.length === 1, `a second panel appended ${uiRoot2.children.length} child(ren) to its own uiRoot, expected 1`)

    panel.destroy()
    expect(card.removed === true, 'destroy() did not call remove() on the card')
    expect(uiRoot.children.length === 0, `destroy() left ${uiRoot.children.length} child(ren) in uiRoot, expected 0`)
  } finally {
    if (hadDocument) globalThis.document = oldDocument
    else delete globalThis.document
    if (hadWindow) globalThis.window = oldWindow
    else delete globalThis.window
  }

  return { failures, facts }
}

const MUTANTS = [
  { id: 'get-unwired', from: 'input.checked = t.get()', to: 'input.checked = false' },
  { id: 'set-unwired', from: "input.addEventListener('change', () => t.set(input.checked))", to: "input.addEventListener('change', () => {})" },
  { id: 'style-not-appended', from: 'document.head.appendChild(s)', to: 'void s' },
  { id: 'destroy-noop', from: 'destroy() { card.remove() }', to: 'destroy() { void card }' },
  { id: 'host-shadow-inverted', from: 'window.__hostShadowOff = !on', to: 'window.__hostShadowOff = on' },
  { id: 'cascade-clears-sun', from: 'for (let i = 1; i < sp.lights.length; i++)', to: 'for (let i = 0; i < sp.lights.length; i++)' },
  { id: 'ssao-never-written', from: "renderControls?.set('ssao', on)", to: 'void on' },
]

async function main() {
  const source = readFileSync(PANEL_ABS, 'utf8')
  console.log(`${TAG} driving ${PANEL_LABEL} (${source.split('\n').length} lines) with a stub document + window`)

  const honest = await drivePanel(pathToFileURL(PANEL_ABS).href)
  console.log(`${TAG} honest tree: ${honest.facts.checks} check(s), ${honest.facts.toggles} toggle write(s), ${honest.facts.listeners} change listener(s), ${honest.facts.sets} set call(s) driven`)
  console.log(`${TAG} honest failures: ${JSON.stringify(honest.failures)}`)

  const scratch = mkdtempSync(join(tmpdir(), 'rdp-panel-witness-'))
  const survivors = []
  let mutantsCaught = 0
  try {
    if (!SELFCHECK) {
      console.log(`${TAG} --source given: the tree under test is the mutant, so the scratch-mutant sweep is skipped`)
    }
    for (const mutant of SELFCHECK ? MUTANTS : []) {
      const occurrences = source.split(mutant.from).length - 1
      if (occurrences !== 1) {
        survivors.push(`${mutant.id} (mutation anchor occurs ${occurrences} time(s), expected 1)`)
        continue
      }
      const file = join(scratch, `render-debug-panel-${mutant.id}.mjs`)
      writeFileSync(file, source.split(mutant.from).join(mutant.to), 'utf8')
      const run = await drivePanel(pathToFileURL(file).href)
      if (run.failures.length === 0) {
        survivors.push(`${mutant.id} (${run.facts.checks} check(s) all passed against the mutant)`)
        console.error(`${TAG} mutant ${mutant.id} SURVIVED: ${run.facts.checks} check(s) passed`)
      } else {
        mutantsCaught += 1
        console.log(`${TAG} mutant ${mutant.id} caught by: ${run.failures[0]}`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  if (SELFCHECK) console.log(`${TAG} mutants caught: ${mutantsCaught}/${MUTANTS.length}`)
  if (honest.failures.length > 0 || survivors.length > 0) {
    console.log(`${TAG} RESULT: FAIL -- ${honest.failures.length} failure(s) on ${PANEL_LABEL} (first: ${honest.failures[0] ?? 'none'}), surviving mutant(s): ${survivors.join('; ') || 'none'}`)
    process.exit(1)
  }
  console.log(`${TAG} RESULT: PASS -- ${honest.facts.checks} check(s) over ${honest.facts.toggles} toggle write(s) on ${PANEL_LABEL}${SELFCHECK ? `, ${mutantsCaught}/${MUTANTS.length} scratch mutant(s) caught` : ''}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(`${TAG} run FAILED: ${e && e.stack ? e.stack : e}`)
  console.log(`${TAG} RESULT: FAIL -- witness aborted before it reached a verdict: ${e && e.message ? e.message : e}`)
  process.exit(1)
})
