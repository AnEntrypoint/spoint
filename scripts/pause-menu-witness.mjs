import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const DEFAULT_MODULE_URL = new URL('../client/hud/PauseMenu.js', import.meta.url).href
const moduleArg = process.argv.find((arg) => arg.startsWith('--module='))
const MODULE_URL = moduleArg ? pathToFileURL(resolve(moduleArg.slice('--module='.length))).href : DEFAULT_MODULE_URL

const START_HREF = 'https://game.test/play/room-7/index.html'
const INVITE_LINK = 'https://game.test/join/ABC123'

const lockCalls = []
const resumeCalls = []
const settingsCalls = []
const leaveCalls = []
const clipboardWrites = []
const animationFrames = []
const timers = []
let clipboardFails = false

let passes = 0
let failures = 0

function expect(name, ok, detail) {
  if (ok) {
    passes++
    process.stdout.write(`[PASS] ${name}\n`)
  } else {
    failures++
    process.stdout.write(`[FAIL] ${name}${detail === undefined ? '' : ` -- ${detail}`}\n`)
  }
}

class StubElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.id = ''
    this.parentNode = null
    this.children = []
    this.attributes = new Map()
    this.listeners = new Map()
    this.classes = new Set()
    this.text = ''
    this.html = ''
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    }
  }

  get className() {
    return [...this.classes].join(' ')
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean))
  }

  get textContent() {
    return this.text
  }

  set textContent(value) {
    this.text = String(value)
  }

  get innerHTML() {
    return this.html
  }

  set innerHTML(value) {
    this.html = String(value)
    if (this.html === '') {
      this.children.forEach((child) => { child.parentNode = null })
      this.children = []
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  appendChild(child) {
    child.remove()
    child.parentNode = this
    this.children.push(child)
    return child
  }

  remove() {
    if (!this.parentNode) return
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this)
    this.parentNode = null
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(listener)
  }

  dispatch(type, event) {
    return (this.listeners.get(type) || []).map((listener) => listener(event))
  }
}

const head = new StubElement('head')
const body = new StubElement('body')

function findById(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = findById(node.children, id)
    if (hit) return hit
  }
  return null
}

const documentStub = {
  head,
  body,
  createElement: (tagName) => new StubElement(tagName),
  getElementById: (id) => findById([head, body], id),
}

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false })
}

function installStubs() {
  setGlobal('document', documentStub)
  setGlobal('location', { href: START_HREF })
  setGlobal('navigator', {
    clipboard: {
      writeText: async (text) => {
        if (clipboardFails) throw new Error('clipboard denied')
        clipboardWrites.push(text)
      },
    },
  })
  setGlobal('requestAnimationFrame', (callback) => {
    animationFrames.push(callback)
    return animationFrames.length
  })
  setGlobal('setTimeout', (callback, ms) => {
    timers.push({ callback, ms, cleared: false, fired: false })
    return timers.length
  })
  setGlobal('clearTimeout', (handle) => {
    if (timers[handle - 1]) timers[handle - 1].cleared = true
  })
}

function flushAnimationFrames() {
  while (animationFrames.length) animationFrames.shift()()
}

function fireTimers(ms) {
  for (const timer of timers) {
    if (timer.ms === ms && !timer.cleared && !timer.fired) {
      timer.fired = true
      timer.callback()
    }
  }
}

const buttonsOf = (panel) => panel.children.filter((child) => child.tagName === 'BUTTON')
const labelsOf = (panel) => buttonsOf(panel).map((button) => button.textContent)
const buttonNamed = (panel, label) => buttonsOf(panel).find((button) => button.textContent === label)
const sameLabels = (labels, expected) => JSON.stringify(labels) === JSON.stringify(expected)

async function clickButton(panel, label) {
  const button = buttonNamed(panel, label)
  if (!button) throw new Error(`no "${label}" button in the panel`)
  await Promise.all(button.dispatch('click', {}))
}

async function main() {
  process.stdout.write(`module: ${MODULE_URL}\n`)
  process.stdout.write(`run: ${new Date().toISOString()}\n`)
  expect('no window or document global before the stubs are installed', typeof globalThis.window === 'undefined' && typeof globalThis.document === 'undefined')
  installStubs()
  const G = await import(MODULE_URL)
  expect('exports createPauseMenu as a function', typeof G.createPauseMenu === 'function', typeof G.createPauseMenu)

  const live = []
  const makeMenu = (options = {}) => {
    live.splice(0).forEach((menu) => menu.destroy())
    const menu = G.createPauseMenu(options)
    live.push(menu)
    return menu
  }
  const overlay = () => document.getElementById('pause-menu-overlay')
  const panel = () => document.getElementById('pause-menu-panel')
  const optionsWithRoom = (getRoomInfo) => ({
    requestPointerLock: () => lockCalls.push('lock'),
    settingsMenu: { open: () => settingsCalls.push('open') },
    onLeaveMatch: () => leaveCalls.push('leave'),
    getRoomInfo,
  })
  const withJoinLink = () => optionsWithRoom(() => ({ joinLink: INVITE_LINK }))
  const styleCount = () => document.head.children.filter((child) => child.id === 'pause-menu-style').length

  makeMenu(withJoinLink())
  expect('ensureStyles adds one pause-menu-style element to head', styleCount() === 1 && document.getElementById('pause-menu-style').textContent.includes('#pause-menu-overlay'))
  makeMenu(withJoinLink())
  expect('ensureStyles adds the style element only once across menus', styleCount() === 1)

  const menu = makeMenu(withJoinLink())
  expect('overlay is a dialog on body that holds the panel', overlay() !== null && overlay().parentNode === document.body && overlay().getAttribute('role') === 'dialog' && overlay().getAttribute('aria-modal') === 'true' && overlay().getAttribute('aria-label') === 'Paused' && panel() !== null && panel().parentNode === overlay())
  expect('menu starts closed', menu.isOpen === false && !overlay().classList.contains('open'))

  menu.open()
  expect('open() adds the open class and reports isOpen', overlay().classList.contains('open') && menu.isOpen === true)
  expect('the panel header reads Paused', panel().children[0].tagName === 'H2' && panel().children[0].textContent === 'Paused')
  const labels = labelsOf(panel())
  expect('open() renders Resume, Settings, Invite Friends and Leave Match in order', sameLabels(labels, ['Resume', 'Settings', 'Invite Friends', 'Leave Match']), JSON.stringify(labels))
  expect('Resume is the primary button and Leave Match the danger button', buttonNamed(panel(), 'Resume').className === 'pm-primary' && buttonNamed(panel(), 'Leave Match').className === 'pm-danger')
  menu.open()
  expect('a second open() re-renders the panel without duplicating buttons', labelsOf(panel()).length === 4)

  const resumesBefore = resumeCalls.length
  const locksBeforeResume = lockCalls.length
  menu.onResume(() => resumeCalls.push('resume'))
  await clickButton(panel(), 'Resume')
  expect('Resume removes the open class and reports closed', !overlay().classList.contains('open') && menu.isOpen === false)
  expect('Resume calls requestPointerLock exactly once', lockCalls.length === locksBeforeResume + 1)
  expect('Resume calls the onResume callback exactly once', resumeCalls.length === resumesBefore + 1)

  makeMenu(withJoinLink()).open()
  const settingsBefore = settingsCalls.length
  await clickButton(panel(), 'Settings')
  expect('Settings opens the settings menu exactly once', settingsCalls.length === settingsBefore + 1)
  makeMenu({}).open()
  let settingsError = null
  try {
    await clickButton(panel(), 'Settings')
  } catch (error) {
    settingsError = error
  }
  expect('Settings without a settings menu does not throw', settingsError === null, settingsError && settingsError.message)

  makeMenu(withJoinLink()).open()
  const leavesBefore = leaveCalls.length
  const hrefBefore = location.href
  await clickButton(panel(), 'Leave Match')
  expect('Leave Match closes the overlay and calls onLeaveMatch exactly once', !overlay().classList.contains('open') && leaveCalls.length === leavesBefore + 1)
  expect('Leave Match with onLeaveMatch leaves the location alone', location.href === hrefBefore, location.href)
  makeMenu({}).open()
  await clickButton(panel(), 'Leave Match')
  expect('Leave Match without onLeaveMatch closes the overlay and navigates to landing/', !overlay().classList.contains('open') && location.href === new URL('landing/', hrefBefore).href, location.href)

  makeMenu(withJoinLink()).open()
  const writesBefore = clipboardWrites.length
  await clickButton(panel(), 'Invite Friends')
  expect('Invite Friends writes the room join link to the clipboard once', clipboardWrites.length === writesBefore + 1 && clipboardWrites[clipboardWrites.length - 1] === INVITE_LINK)
  const toast = document.getElementById('pause-menu-toast')
  expect('a successful copy puts Join link copied in a toast on body', toast !== null && toast.parentNode === document.body && toast.textContent === 'Join link copied')
  expect('the toast is not shown before the next animation frame', !toast.classList.contains('show'))
  flushAnimationFrames()
  expect('the animation frame adds the show class to the toast', toast.classList.contains('show'))
  fireTimers(2200)
  expect('the toast hides after 2200 ms', !toast.classList.contains('show'))
  clipboardFails = true
  await clickButton(panel(), 'Invite Friends')
  clipboardFails = false
  expect('a failed copy puts the join link itself in the toast', toast.textContent === INVITE_LINK)
  expect('a failed copy writes nothing new to the clipboard', clipboardWrites.length === writesBefore + 1)

  makeMenu(optionsWithRoom(() => ({}))).open()
  expect('no Invite Friends button without a join link', sameLabels(labelsOf(panel()), ['Resume', 'Settings', 'Leave Match']), JSON.stringify(labelsOf(panel())))
  let currentRoom = null
  const roomMenu = makeMenu(optionsWithRoom(() => currentRoom))
  roomMenu.open()
  const inviteBeforeRoom = labelsOf(panel()).includes('Invite Friends')
  currentRoom = { joinLink: INVITE_LINK }
  roomMenu.open()
  expect('room info is read on each open, so Invite Friends appears once a join link exists', !inviteBeforeRoom && labelsOf(panel()).includes('Invite Friends'))

  const doomed = makeMenu(withJoinLink())
  doomed.open()
  doomed.destroy()
  expect('destroy removes the overlay from the document', document.getElementById('pause-menu-overlay') === null)

  makeMenu(withJoinLink()).open()
  const locksBeforeBackdrop = lockCalls.length
  overlay().dispatch('mousedown', { target: panel() })
  expect('a mousedown inside the panel keeps the menu open', overlay().classList.contains('open') && lockCalls.length === locksBeforeBackdrop)
  overlay().dispatch('mousedown', { target: overlay() })
  expect('a mousedown on the backdrop closes the menu and resumes play', !overlay().classList.contains('open') && lockCalls.length === locksBeforeBackdrop + 1)

  const bare = makeMenu({})
  bare.open()
  bare.resume()
  expect('resume() with no lock or callback still closes the menu', !overlay().classList.contains('open') && bare.isOpen === false)

  live.splice(0).forEach((menu) => menu.destroy())
  process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} -- ${passes} of ${passes + failures} check(s) passed\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  process.stdout.write(`[FAIL] witness aborted -- ${error && error.message}\n`)
  process.stdout.write('RESULT: FAIL -- witness aborted before every check ran\n')
  process.exitCode = 1
})
