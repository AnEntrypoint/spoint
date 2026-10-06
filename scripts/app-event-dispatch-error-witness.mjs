import { format } from 'node:util'
import { createAppModuleSystem } from '../client/AppModuleSystem.js'

const _RealBlob = globalThis.Blob
globalThis.Blob = class Blob extends _RealBlob {
  constructor(parts, options) {
    super(parts, options)
    this._source = Array.isArray(parts) ? parts.join('') : String(parts ?? '')
  }
}
URL.createObjectURL = (blob) => `data:text/javascript;base64,${Buffer.from(blob?._source ?? '', 'utf8').toString('base64')}`
URL.revokeObjectURL = () => {}

globalThis.document = { createElement: () => ({ appendChild() {}, style: {} }) }

const _captured = []
const _realError = console.error
console.error = (...args) => { _captured.push(format(...args)) }

const _received = []
globalThis.__recordEvent = (payload) => { _received.push(payload?.type ?? null) }

const _throwerSource = `export default { client: { setup() {}, onInput() {}, onEvent(payload) { return throwFromArenaCombatHandler(payload) } } }
function throwFromArenaCombatHandler(payload) { return payload.target.x }
`

const _observerSource = `export default { client: { setup() {}, onEvent(payload) { __recordEvent(payload) } } }
`

const _uiRoot = { appendChild() {} }
const sys = createAppModuleSystem(null, _uiRoot)
await sys.loadAppModule({ app: 'arena-combat', code: _throwerSource }, null)
await sys.loadAppModule({ app: 'spectator-hud', code: _observerSource }, null)

sys.dispatchInput({ type: 'move_axis' }, null)
const _quietCaptures = _captured.length

sys.dispatchEvent({ type: 'arena_hit', playerId: 7 }, null)
console.error = _realError

process.stdout.write(`modules loaded: ${sys.list.length}\n`)
process.stdout.write(`captured lines: ${_captured.length}\n`)
for (const line of _captured) process.stdout.write(`--- captured verbatim ---\n${line}\n--- end ---\n`)

let _failures = 0
function expect(name, ok, detail) {
  if (ok) process.stdout.write(`[PASS] ${name}\n`)
  else { _failures++; process.stdout.write(`[FAIL] ${name}${detail ? ` -- ${detail}` : ''}\n`) }
}

expect('two app modules registered through the real loadAppModule path', sys.list.length === 2, `got ${sys.list.length}`)
expect('no log on the non-throwing dispatch path', _quietCaptures === 0, `got ${_quietCaptures} line(s)`)
expect('one app throwing logs exactly one line', _captured.length === 1, `got ${_captured.length}`)
expect('app listed after the thrower still receives the event', _received.length === 1 && _received[0] === 'arena_hit', `got ${JSON.stringify(_received)}`)

const line = _captured[0] ?? ''
expect('log names the throwing app', line.includes('arena-combat'), line)
expect('log names the event', line.includes('arena_hit'), line)
expect('log carries a stack frame at the throwing handler', line.includes('throwFromArenaCombatHandler'), line)
expect('log stays on one line', !line.includes('\n'), line)

process.exit(_failures ? 1 : 0)
