// Witness: the FS-browse save command always carries a required base revision
// (never an absent/undefined optimistic-concurrency token).
//
// Live: imports the real client/editor/EditorFsBrowse.js and drives it. The kit's
// bare 'anentrypoint-design' specifier resolves only through the page importmap
// (it is not installed in node_modules), so it is adapted to a stub here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const KIT = 'anentrypoint-design'

const walk = (dir, acc) => {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return acc }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.js')) acc.push(p)
  }
  return acc
}

const kitNames = new Set(['components', 'h', 'applyDiff'])
for (const file of walk(path.join(ROOT, 'client'), [])) {
  const src = fs.readFileSync(file, 'utf8')
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]anentrypoint-design['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) kitNames.add(name)
    }
  }
}
const kitStub = [...kitNames]
  .map(n => (n === 'components'
    ? 'export const components = new Proxy({}, { get: () => () => ({}) })'
    : 'export const ' + n + ' = () => ({})'))
  .join('\n') + '\nexport default {}\n'
const kitUrl = 'data:text/javascript,' + encodeURIComponent(kitStub)
const loaderUrl = 'data:text/javascript,' + encodeURIComponent(
  'export async function resolve(specifier, context, next) {' +
  ' if (specifier === ' + JSON.stringify(KIT) + ') return { url: ' + JSON.stringify(kitUrl) + ', shortCircuit: true };' +
  ' return next(specifier, context) }'
)
register(loaderUrl)

class ElementStub {}
globalThis.Element = ElementStub
globalThis.HTMLElement = ElementStub
globalThis.Node = ElementStub
globalThis.Event = class { constructor(type) { this.type = type } preventDefault() {} stopPropagation() {} }
globalThis.CustomEvent = globalThis.Event
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

function mkEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(), nodeType: 1, className: '', id: '', title: '', href: '',
    value: '', textContent: '', tabIndex: 0, spellcheck: false, isConnected: true, parentNode: null,
    children: [], childNodes: [], _listeners: {},
    style: { cssText: '', setProperty() {}, removeProperty() {} },
    classList: { _s: new Set(), add(...c) { c.forEach(x => this._s.add(x)) }, remove(...c) { c.forEach(x => this._s.delete(x)) }, toggle() {}, contains(c) { return this._s.has(c) } },
    appendChild(c) { c.parentNode = node; node.children.push(c); node.childNodes.push(c); return c },
    append(...cs) { cs.forEach(c => node.appendChild(typeof c === 'string' ? { nodeType: 3, textContent: c } : c)) },
    prepend(...cs) { cs.forEach(c => { c.parentNode = node; node.children.unshift(c); node.childNodes.unshift(c) }) },
    insertBefore(c, ref) { c.parentNode = node; const i = node.children.indexOf(ref); const at = i < 0 ? node.children.length : i; node.children.splice(at, 0, c); node.childNodes.splice(at, 0, c); return c },
    removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) { node.children.splice(i, 1); node.childNodes.splice(i, 1) } return c },
    replaceChildren(...cs) { node.children.length = 0; node.childNodes.length = 0; cs.forEach(c => node.appendChild(c)) },
    remove() { if (node.parentNode) node.parentNode.removeChild(node) },
    setAttribute(k, v) { node[k] = v }, getAttribute(k) { return node[k] },
    addEventListener(t, fn) { (node._listeners[t] = node._listeners[t] || []).push(fn) },
    removeEventListener(t, fn) { const a = node._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
    closest() { return null }, querySelector() { return null }, querySelectorAll() { return [] },
    contains(c) { return node.children.includes(c) },
    getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } },
    focus() {}, blur() {},
    click() { (node._listeners.click || []).forEach(f => f({ preventDefault() {}, target: node, currentTarget: node })) },
    get firstChild() { return node.childNodes[0] || null },
    get lastChild() { return node.childNodes[node.childNodes.length - 1] || null },
    get nextSibling() { const p = node.parentNode; if (!p) return null; const i = p.childNodes.indexOf(node); return p.childNodes[i + 1] || null }
  }
  Object.defineProperty(node, 'innerHTML', { get() { return '' }, set() { node.children.length = 0; node.childNodes.length = 0 } })
  Object.setPrototypeOf(node, ElementStub.prototype)
  return node
}
const body = mkEl('body')
globalThis.document = {
  body, head: mkEl('head'), documentElement: mkEl('html'),
  createElement: mkEl, createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => []
}
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, innerWidth: 800, innerHeight: 600,
  matchMedia: () => ({ matches: false, addEventListener() {} }), getComputedStyle: () => ({})
}

const REVISION = 1700000000000
let fails = 0
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) { fails++; console.log('FAIL ' + name + ': got ' + g + ' want ' + w) } else { console.log('ok ' + name + ': ' + g) }
}

const mod = await import(pathToFileURL(path.join(ROOT, 'client/editor/EditorFsBrowse.js')).href)

// The base revision is a required descriptor: null means "no known revision", never undefined.
check('fsSaveBase(null)', mod.fsSaveBase(null), null)
check('fsSaveBase(unversioned)', mod.fsSaveBase({ source: 'c', mtimeMs: undefined }), { mtimeMs: null })
check('fsSaveBase(revision)', mod.fsSaveBase({ source: 'c', mtimeMs: REVISION }), { mtimeMs: REVISION })

const drive = (load, mtimeMs) => {
  const container = mkEl('div')
  const saves = [], reloads = []
  const panel = mod.createEditorFsBrowse(container, {
    onListTree: () => {}, onGetSource: (p) => reloads.push(p), onSave: (...a) => saves.push(a),
    onMkdir: () => {}, onDelete: () => {}, onRename: () => {}
  })
  panel.setTree([{ name: 'a.js', type: 'file', size: 10 }], null)
  container.children[2].children[0]._listeners.click[0]({ preventDefault() {}, target: container.children[2].children[0] })
  if (load) panel.setSource('a.js', { kind: 'text', source: 'code', mtimeMs })
  else panel.render()
  const pane = container.children[container.children.length - 1]
  pane.children[0]._listeners.keydown[0]({ ctrlKey: true, key: 's', preventDefault() {} })
  return { saves, reloads }
}

const refused = drive(false)
check('refused-save-not-sent', refused.saves.length, 0)
check('refused-save-reloads', refused.reloads, ['a.js', 'a.js'])
check('save-with-revision', drive(true, REVISION).saves, [['a.js', 'code', { mtimeMs: REVISION }]])
check('save-unversioned', drive(true, undefined).saves, [['a.js', 'code', { mtimeMs: null }]])

console.log(fails === 0 ? 'RESULT: PASS' : 'RESULT: FAIL (' + fails + ')')
if (fails !== 0) process.exitCode = 1
