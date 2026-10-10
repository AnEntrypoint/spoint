import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HONEST_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'hud', 'EmoteWheel.js')
const MODULE_FLAG = '--module='
const modulePath = process.argv.find(arg => arg.startsWith(MODULE_FLAG))?.slice(MODULE_FLAG.length) ?? HONEST_MODULE

const elementsById = new Map()

class FakeClassList {
  constructor() { this.names = new Set() }
  add(...names) { for (const name of names) this.names.add(name) }
  remove(...names) { for (const name of names) this.names.delete(name) }
  contains(name) { return this.names.has(name) }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.id = ''
    this.className = ''
    this.textContent = ''
    this.style = {}
    this.classList = new FakeClassList()
    this.childNodes = []
    this.parent = null
  }

  appendChild(child) {
    child.parent = this
    this.childNodes.push(child)
    if (child.id) elementsById.set(child.id, child)
    return child
  }

  remove() {
    if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(node => node !== this)
    if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id)
    this.parent = null
  }
}

const head = new FakeElement('head')
const body = new FakeElement('body')
globalThis.document = {
  head,
  body,
  getElementById: id => elementsById.get(id) ?? null,
  createElement: tagName => new FakeElement(tagName),
}

const overlaysInBody = () => body.childNodes.filter(node => node.id === 'emote-wheel-overlay')
const styleElementsInHead = () => head.childNodes.filter(node => node.id === 'emote-wheel-style')
const slotElementsOf = overlay => overlay.childNodes[0].childNodes.filter(node => node.className === 'ew-slot')
const activeSlotIndices = slotEls => slotEls.flatMap((el, index) => (el.classList.contains('active') ? [index] : []))
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

const verdicts = []

function expect(name, ok, detail) {
  verdicts.push(ok)
  if (ok) process.stdout.write(`[PASS] ${name}\n`)
  else process.stdout.write(`[FAIL] ${name} -- ${detail}\n`)
}

const FOUR_SLOTS = [
  { label: 'Wave', clip: 'wave' },
  { label: 'Cheer', clip: 'cheer' },
  { label: 'Bow', clip: 'bow' },
  { label: 'Laugh', clip: 'laugh' },
]

const NINE_SLOTS = Array.from({ length: 9 }, (_, index) => ({ label: `Slot${index + 1}`, clip: `clip${index + 1}` }))

async function runScenarios() {
  const { createEmoteWheel } = await import(pathToFileURL(modulePath).href)
  expect('module exports createEmoteWheel', typeof createEmoteWheel === 'function', `typeof ${typeof createEmoteWheel}`)
  expect(
    'witness environment defines no window, HTMLElement or WebGL global',
    typeof globalThis.window === 'undefined' && typeof globalThis.HTMLElement === 'undefined' && typeof globalThis.WebGL2RenderingContext === 'undefined',
    'a browser or GPU global is defined',
  )

  const wheel = createEmoteWheel(FOUR_SLOTS)
  const [overlay] = overlaysInBody()
  const slotEls = slotElementsOf(overlay)
  expect('creation mounts exactly one overlay on document.body', overlaysInBody().length === 1, `overlays ${overlaysInBody().length}`)
  expect('creation injects exactly one style element into document.head', styleElementsInHead().length === 1, `style elements ${styleElementsInHead().length}`)
  expect(
    'one slot per entry, each carrying its digit and label',
    slotEls.length === FOUR_SLOTS.length && slotEls.every((el, index) => el.childNodes[0].textContent === String(index + 1) && el.childNodes[1].textContent === FOUR_SLOTS[index].label),
    `slots ${slotEls.length}`,
  )
  expect('wheel starts closed', wheel.isOpen === false && overlay.classList.contains('open') === false, `isOpen ${wheel.isOpen}`)

  const opened = wheel.update(true, 0)
  expect('hold opens the overlay', opened.open === true && wheel.isOpen === true && overlay.classList.contains('open') === true, `open ${opened.open}, isOpen ${wheel.isOpen}`)
  expect(
    'hold without a digit reports no clip and marks no slot',
    opened.digit === 0 && opened.clip === null && same(activeSlotIndices(slotEls), []),
    `digit ${opened.digit}, clip ${opened.clip}, active ${JSON.stringify(activeSlotIndices(slotEls))}`,
  )

  const picked = wheel.update(true, 3)
  expect('digit 3 reports its clip and keeps the wheel open', picked.digit === 3 && picked.clip === 'bow' && picked.open === true, `digit ${picked.digit}, clip ${picked.clip}, open ${picked.open}`)
  expect('digit 3 marks exactly slot index 2 active', same(activeSlotIndices(slotEls), [2]), `active ${JSON.stringify(activeSlotIndices(slotEls))}`)

  const moved = wheel.update(true, 2)
  expect('digit 2 moves the active mark to slot index 1', moved.clip === 'cheer' && same(activeSlotIndices(slotEls), [1]), `clip ${moved.clip}, active ${JSON.stringify(activeSlotIndices(slotEls))}`)

  const last = wheel.update(true, 4)
  expect('digit 4 (last slot) selects the last clip', last.clip === 'laugh' && same(activeSlotIndices(slotEls), [3]), `clip ${last.clip}, active ${JSON.stringify(activeSlotIndices(slotEls))}`)

  const pastEnd = wheel.update(true, 5)
  expect('digit 5 (past the last slot) reports no clip and marks no slot', pastEnd.clip === null && same(activeSlotIndices(slotEls), []), `clip ${pastEnd.clip}, active ${JSON.stringify(activeSlotIndices(slotEls))}`)

  const closed = wheel.update(false, 0)
  expect('release closes the wheel and clears the digit', closed.open === false && closed.digit === 0 && closed.clip === null && wheel.isOpen === false, `open ${closed.open}, digit ${closed.digit}, clip ${closed.clip}, isOpen ${wheel.isOpen}`)
  expect('release removes the open class from the overlay', overlay.classList.contains('open') === false, 'the open class is still on the overlay')
  expect('release leaves no slot marked active', same(activeSlotIndices(slotEls), []), `active ${JSON.stringify(activeSlotIndices(slotEls))}`)

  const idle = wheel.update(false, 0)
  expect('release while already closed changes nothing', idle.open === false && overlay.classList.contains('open') === false, `open ${idle.open}`)

  wheel.dispose()
  expect('dispose removes the overlay from document.body', overlaysInBody().length === 0, `overlays ${overlaysInBody().length}`)

  const wide = createEmoteWheel(NINE_SLOTS)
  const [wideOverlay] = overlaysInBody()
  expect('a second wheel reuses the style element', styleElementsInHead().length === 1, `style elements ${styleElementsInHead().length}`)
  expect('nine entries render eight slots', slotElementsOf(wideOverlay).length === 8, `slots ${slotElementsOf(wideOverlay).length}`)

  const wideFirst = wide.update(true, 1)
  expect('the second wheel selects its own first clip', wideFirst.clip === 'clip1' && same(activeSlotIndices(slotElementsOf(wideOverlay)), [0]), `clip ${wideFirst.clip}, active ${JSON.stringify(activeSlotIndices(slotElementsOf(wideOverlay)))}`)

  wide.dispose()
  expect('disposing the second wheel leaves no overlay', overlaysInBody().length === 0, `overlays ${overlaysInBody().length}`)
}

async function main() {
  let crash = null
  try {
    process.stdout.write(`module: ${modulePath}\n`)
    process.stdout.write(`module sha256: ${createHash('sha256').update(readFileSync(modulePath)).digest('hex')}\n`)
    process.stdout.write(`run: ${new Date().toISOString()}\n`)
    await runScenarios()
  } catch (error) {
    crash = error
  }
  if (crash) expect('scenarios run to completion', false, crash.stack || String(crash))
  const passed = verdicts.filter(Boolean).length
  const failed = verdicts.length - passed
  process.stdout.write(`RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} -- ${passed} of ${verdicts.length} check(s) passed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

await main()
