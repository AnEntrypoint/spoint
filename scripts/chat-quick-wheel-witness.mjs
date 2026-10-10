import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HONEST_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'hud', 'ChatQuickWheel.js')
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

const body = new FakeElement('body')
globalThis.document = {
  head: new FakeElement('head'),
  body,
  getElementById: id => elementsById.get(id) ?? null,
  createElement: tagName => new FakeElement(tagName),
}

const overlaysInBody = () => body.childNodes.filter(node => node.id === 'emote-wheel-overlay').length

const verdicts = []

function expect(name, ok, detail) {
  verdicts.push(ok)
  if (ok) process.stdout.write(`[PASS] ${name}\n`)
  else process.stdout.write(`[FAIL] ${name} -- ${detail}\n`)
}

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

function createRecordingChat() {
  const sent = []
  return {
    sent,
    send(text) {
      sent.push(text)
      return Promise.resolve()
    },
  }
}

async function runScenarios() {
  const { createChatQuickWheel, DEFAULT_QUICK_MESSAGES } = await import(pathToFileURL(modulePath).href)
  const FOUR_MESSAGES = ['Alpha', 'Bravo', 'Charlie', 'Delta']

  const chatA = createRecordingChat()
  const wheelA = createChatQuickWheel(() => chatA, FOUR_MESSAGES)
  expect('wheel starts closed', wheelA.isOpen === false, `isOpen ${wheelA.isOpen}`)

  const pressed = wheelA.update(true, 0)
  expect('press opens the wheel', pressed.open === true && wheelA.isOpen === true, `open ${pressed.open}, isOpen ${wheelA.isOpen}`)
  expect('press sends nothing', same(chatA.sent, []), `sent ${JSON.stringify(chatA.sent)}`)

  const digited = wheelA.update(true, 3)
  expect('digit reports its selected clip', digited.digit === 3 && digited.clip === 'Charlie', `digit ${digited.digit}, clip ${digited.clip}`)
  expect('digit keeps the wheel open', wheelA.isOpen === true, `isOpen ${wheelA.isOpen}`)
  expect('digit alone sends nothing', same(chatA.sent, []), `sent ${JSON.stringify(chatA.sent)}`)

  const released = wheelA.update(false, 0)
  expect('release sends the selected message exactly once', same(chatA.sent, ['Charlie']), `sent ${JSON.stringify(chatA.sent)}`)
  expect('release closes the wheel', released.open === false && wheelA.isOpen === false, `open ${released.open}, isOpen ${wheelA.isOpen}`)

  const overlaysBeforeDispose = overlaysInBody()
  wheelA.dispose()
  expect('dispose removes the overlay from the body', overlaysBeforeDispose === 1 && overlaysInBody() === 0, `before ${overlaysBeforeDispose}, after ${overlaysInBody()}`)

  const chatB = createRecordingChat()
  const wheelB = createChatQuickWheel(() => chatB)
  wheelB.update(true, 0)
  wheelB.update(false, 0)
  expect('release without a digit sends nothing', same(chatB.sent, []), `sent ${JSON.stringify(chatB.sent)}`)
  wheelB.update(true, 0)
  wheelB.update(true, 1)
  wheelB.update(false, 0)
  expect('omitted messages fall back to DEFAULT_QUICK_MESSAGES', same(chatB.sent, [DEFAULT_QUICK_MESSAGES[0]]), `sent ${JSON.stringify(chatB.sent)}`)
  wheelB.dispose()

  const chatC = createRecordingChat()
  const wheelC = createChatQuickWheel(() => chatC, FOUR_MESSAGES)
  wheelC.update(true, 0)
  wheelC.update(true, 4)
  wheelC.update(false, 0)
  expect('last valid digit sends the last message', same(chatC.sent, ['Delta']), `sent ${JSON.stringify(chatC.sent)}`)
  wheelC.update(true, 0)
  wheelC.update(true, 5)
  wheelC.update(false, 0)
  expect('digit past the last slot sends nothing', same(chatC.sent, ['Delta']), `sent ${JSON.stringify(chatC.sent)}`)
  wheelC.dispose()

  expect('no overlay is left in the body after every dispose', overlaysInBody() === 0, `overlays ${overlaysInBody()}`)
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
