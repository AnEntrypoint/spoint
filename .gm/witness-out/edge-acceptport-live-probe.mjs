import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const REPO = 'C:/dev/spoint'
const SHIM_URL = pathToFileURL(REPO + '/.gm/witness-out/edge-jolt-wasm-shim.mjs').href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'jolt-physics/dist/jolt-physics.wasm.wasm') return { url: SHIM_URL, shortCircuit: true }
    return next(specifier, context)
  },
})

const mod = await import(pathToFileURL(REPO + '/edge/cf-do/spoint-do.js').href)
const boundary = await import(pathToFileURL(REPO + '/edge/cf-do/accept-request.js').href)
console.log('EXPORTS ' + JSON.stringify(Object.keys(mod)))
console.log('WITNESS_DISPATCH ' + (process.env.GM_DISPATCH_ID || 'unset'))

class FakeWS { accept() {} addEventListener() {} close() {} send() {} }
globalThis.WebSocketPair = function () { return [new FakeWS(), new FakeWS()] }

const checks = []
function expect(name, got, want) {
  const ok = got === want
  checks.push(ok)
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want))
}

function fakeBinding(log) {
  return {
    idFromName(name) { log.push(name); return { name } },
    get(id) {
      return { async fetch() { return new Response('ROOM:' + id.name, { status: 200 }) } }
    },
  }
}

function wsRequest(url) {
  return new Request(url, { headers: { Upgrade: 'websocket' } })
}

// the room admits an upgrade and refuses anything else with the reason
expect('BOUNDARY_WS_ACCEPTED', boundary.acceptRoomRequest(wsRequest('http://x/ws')).accepted, true)
expect('BOUNDARY_WS_MIXED_CASE', boundary.acceptRoomRequest(new Request('http://x/ws', { headers: { Upgrade: 'WebSocket' } })).accepted, true)
expect('BOUNDARY_NON_WS_STATUS', boundary.acceptRoomRequest(new Request('http://x/i.html')).status, 426)

const room = new mod.SpointGameRoom({}, {})
const doNonWs = await room.fetch(new Request('http://x/index.html'))
expect('DO_NON_WS_STATUS', doNonWs.status, 426)
expect('DO_NON_WS_REASON', await doNonWs.text(), 'expected websocket upgrade')

// the entry refuses a static request with no origin, and an upgrade with no binding
expect('ROUTER_NO_ORIGIN_STATUS', (await mod.default.fetch(new Request('http://x/index.html'), {})).status, 502)
expect('ROUTER_WS_NO_BINDING_STATUS', (await mod.default.fetch(wsRequest('http://x/ws'), {})).status, 503)

// an admitted upgrade lands in the room the request names, not one global room
let keys = []
let stubbed = await mod.default.fetch(wsRequest('http://x/ws'), { SPOINT_GAME_ROOM: fakeBinding(keys) })
expect('ROUTER_WS_DEFAULT_KEY', keys[0], 'probe-room')
expect('ROUTER_WS_DEFAULT_BODY', await stubbed.text(), 'ROOM:probe-room')

keys = []
stubbed = await mod.default.fetch(wsRequest('http://x/ws?room=arena-7'), { SPOINT_GAME_ROOM: fakeBinding(keys) })
expect('ROUTER_WS_QUERY_KEY', keys[0], 'arena-7')
expect('ROUTER_WS_QUERY_BODY', await stubbed.text(), 'ROOM:arena-7')

keys = []
const envTwoRooms = { SPOINT_GAME_ROOM: fakeBinding(keys) }
await mod.default.fetch(wsRequest('http://x/ws?room=alpha'), envTwoRooms)
await mod.default.fetch(wsRequest('http://x/ws?room=beta'), envTwoRooms)
expect('ROUTER_WS_KEYS_DISTINCT', keys.join(','), 'alpha,beta')

keys = []
stubbed = await mod.default.fetch(wsRequest('http://x/ws'), { SPOINT_GAME_ROOM: fakeBinding(keys), SPOINT_ROOM_KEY: 'shard-3' })
expect('ROUTER_WS_ENV_ROOM_KEY', keys[0], 'shard-3')

keys = []
stubbed = await mod.default.fetch(wsRequest('http://x/ws'), { ALT_ROOM: fakeBinding(keys), SPOINT_ROOM_BINDING: 'ALT_ROOM' })
expect('ROUTER_WS_BINDING_OVERRIDE_STATUS', stubbed.status, 200)
expect('ROUTER_WS_BINDING_OVERRIDE_KEY', keys[0], 'probe-room')

// an admitted static request reaches the configured origin, tagged
let captured = null
const realFetch = globalThis.fetch
globalThis.fetch = (req) => { captured = req; return new Response('proxied', { status: 200 }) }
const proxied = await mod.default.fetch(new Request('http://x/assets/a.png?b=1'), { STATIC_ORIGIN: 'http://localhost:8090' })
globalThis.fetch = realFetch
expect('ROUTER_STATIC_STATUS', proxied.status, 200)
expect('ROUTER_STATIC_URL', captured && captured.url, 'http://localhost:8090/assets/a.png?b=1')
expect('ROUTER_STATIC_HEADER', captured && captured.headers.get('x-spoint-edge-proxy'), '1')

// the upgrade rule and the two names now live in exactly one file each
const UPGRADE_RULE = /headers\s*\.\s*get\(\s*['"]Upgrade['"]\s*\)/gi
const entrySrc = readFileSync(REPO + '/edge/cf-do/spoint-do.js', 'utf8')
const boundarySrc = readFileSync(REPO + '/edge/cf-do/accept-request.js', 'utf8')
expect('UPGRADE_RULE_SITES_IN_ENTRY', (entrySrc.match(UPGRADE_RULE) || []).length, 0)
expect('UPGRADE_HEADER_LITERALS_IN_BOUNDARY', (boundarySrc.match(/['"]Upgrade['"]/g) || []).length, 1)
expect('ROOM_KEY_LITERALS_IN_ENTRY', (entrySrc.match(/probe-room/g) || []).length, 0)
expect('BINDING_LITERALS_IN_ENTRY', (entrySrc.match(/SPOINT_GAME_ROOM/g) || []).length, 0)

const ok = checks.every(Boolean)
console.log('CHECKS ' + checks.filter(Boolean).length + '/' + checks.length)
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
process.exit(ok ? 0 : 1)
