import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HONEST_MODULE = join(REPO, 'src', 'client', 'InputHandler.js')
const WITNESS = 'InputHandler-witness'
const ROW = 'witness-gap-InputHandler'

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const prefix = `--${name}=`
  const hit = argv.find((arg) => arg.startsWith(prefix))
  return hit === undefined ? null : hit.slice(prefix.length)
}
const modulePath = resolve(flagValue('module') ?? argv.find((arg) => !arg.startsWith('--')) ?? HONEST_MODULE)
const logPath = flagValue('log')

const checks = []
const record = (id, what, expected, observed) => {
  checks.push({ id, what, ok: JSON.stringify(expected) === JSON.stringify(observed), expected, observed })
}

const makeEventTarget = () => {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(listener)
    },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    types: () => [...listeners.keys()].sort(),
    count: (type) => (listeners.get(type) ?? []).length,
  }
}

const win = makeEventTarget()
const doc = makeEventTarget()
const pads = []
globalThis.window = win
globalThis.document = doc
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true, writable: true })

const IDLE = {
  forward: false, backward: false, left: false, right: false, jump: false, sprint: false, crouch: false,
  shoot: false, reload: false, interact: false, editToggle: false, emoteWheelHeld: false, emoteDigit: 0,
  chatWheelHeld: false, chatWheelDigit: 0, mouseX: 0, mouseY: 0, isGamepad: null,
}
const FRAME_KEYS = Object.keys(IDLE)
const pick = (input, keys) => Object.fromEntries(keys.map((key) => [key, input[key] ?? null]))
const frame = (input) => pick(input, FRAME_KEYS)
const expectFrame = (overrides) => ({ ...IDLE, ...overrides })
const pressKey = (code) => win.dispatch('keydown', { code })
const releaseKey = (code) => win.dispatch('keyup', { code })
const listenerCounts = () => [win.count('keydown'), win.count('keyup'), doc.count('mousemove'), doc.count('mousedown'), doc.count('mouseup')]

async function runChecks() {
  const mod = await import(pathToFileURL(modulePath).href)
  const handler = mod.createInputHandler({})

  record('listeners-registered', 'keydown and keyup on window; mousemove, mousedown and mouseup on document',
    { window: ['keydown', 'keyup'], document: ['mousedown', 'mousemove', 'mouseup'] },
    { window: win.types(), document: doc.types() })

  const beforeOptOut = listenerCounts()
  mod.createInputHandler({ enableKeyboard: false, enableMouse: false })
  record('opt-out-adds-no-listeners', 'enableKeyboard false and enableMouse false register no listener', beforeOptOut, listenerCounts())

  record('idle-frame', 'nothing held reports an idle keyboard frame', IDLE, frame(handler.getInput()))

  for (const code of ['KeyW', 'Space', 'ShiftLeft', 'Digit3', 'KeyV']) pressKey(code)
  record('keydown-held', 'held keys set movement, jump, sprint, emote digit and chat wheel',
    expectFrame({ forward: true, jump: true, sprint: true, emoteDigit: 3, chatWheelDigit: 3, chatWheelHeld: true }),
    frame(handler.getInput()))

  releaseKey('KeyW')
  releaseKey('Space')
  record('keyup-releases-only-its-key', 'keyup clears the released keys and leaves the others held',
    expectFrame({ sprint: true, emoteDigit: 3, chatWheelDigit: 3, chatWheelHeld: true }),
    frame(handler.getInput()))

  doc.dispatch('mousemove', { clientX: 320, clientY: 240 })
  record('mousemove-tracked', 'mousemove sets the pointer and the frame mouse position',
    { x: 320, y: 240, down: false, frameMouseX: 320 },
    { x: handler.mouseX, y: handler.mouseY, down: handler.mouseDown, frameMouseX: frame(handler.getInput()).mouseX })

  doc.dispatch('mousedown', {})
  record('mousedown-fires-shoot', 'mousedown sets mouseDown and feeds shoot',
    { down: true, shoot: true },
    { down: handler.mouseDown, shoot: frame(handler.getInput()).shoot })

  doc.dispatch('mouseup', {})
  record('mouseup-releases-shoot', 'mouseup clears mouseDown and shoot',
    { down: false, shoot: false },
    { down: handler.mouseDown, shoot: frame(handler.getInput()).shoot })

  pads.splice(0, pads.length, { connected: true, axes: [0, 0, 0, 0], buttons: [{ pressed: true, value: 1 }] })
  const padFrame = frame(handler.getInput())
  record('gamepad-drives-frame', 'a connected pad from navigator.getGamepads sets jump and isGamepad',
    { isGamepad: true, jump: true },
    { isGamepad: padFrame.isGamepad, jump: padFrame.jump })
  pads.length = 0

  pressKey('KeyD')
  record('keyboard-right-while-enabled', 'a held KeyD reports right while enabled', true, frame(handler.getInput()).right)
  handler.disable()
  record('disable-gates-held-keys', 'disable reports no movement while keys are held',
    { forward: false, right: false, jump: false },
    pick(handler.getInput(), ['forward', 'right', 'jump']))
  handler.enable()
  record('enable-restores-held-keys', 'enable restores movement from held keys', true, frame(handler.getInput()).right)

  record('conflict-pair', 'two actions on one code are reported together',
    { KeyF: ['fire', 'interact'] }, mod.findKeybindConflicts({ fire: 'KeyF', interact: 'KeyF', reload: 'KeyR' }))
  record('conflict-triple', 'three actions on one code are all listed',
    { KeyQ: ['a', 'b', 'c'] }, mod.findKeybindConflicts({ a: 'KeyQ', b: 'KeyQ', c: 'KeyQ' }))
  record('conflict-single-binding', 'one action on a code is not a conflict',
    {}, mod.findKeybindConflicts({ fire: 'KeyF' }))
  record('conflict-clean', 'distinct codes report no conflict',
    {}, mod.findKeybindConflicts({ fire: 'Mouse0', reload: 'KeyR', jump: 'Space' }))
  record('conflict-unbound-skipped', 'unbound (null) actions never conflict',
    {}, mod.findKeybindConflicts({ fire: null, interact: null, reload: 'KeyR' }))
}

let runError = null
try {
  await runChecks()
} catch (error) {
  runError = error
}
if (runError !== null) {
  record('witness-runs-to-completion', 'the module loads and every check runs without throwing', 'no throw', `threw: ${runError && runError.message}`)
}

const failed = checks.filter((check) => !check.ok)
const verdict = checks.length > 0 && failed.length === 0 ? 'PASS' : 'FAIL'
const utc = new Date().toISOString()
const moduleSha = existsSync(modulePath) ? createHash('sha256').update(readFileSync(modulePath)).digest('hex') : 'none'
for (const check of checks) {
  console.log(check.ok
    ? `PASS ${check.id}: ${check.what}`
    : `FAIL ${check.id}: ${check.what} expected=${JSON.stringify(check.expected)} observed=${JSON.stringify(check.observed)}`)
}
const resultLine = `RESULT: ${verdict} -- witness=${WITNESS} row=${ROW} checks=${checks.length} failed=${failed.length} module=${modulePath} module_sha256=${moduleSha} utc=${utc}`
console.log(resultLine)
const exitCode = verdict === 'PASS' ? 0 : 1
process.exitCode = exitCode
if (logPath !== null) appendFileSync(logPath, `${utc} ${WITNESS} exit=${exitCode} ${resultLine}\n`)
