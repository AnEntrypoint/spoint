import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataUrl = (src) => 'data:text/javascript,' + encodeURIComponent(src)

const STUBS = {
  'anentrypoint-design': dataUrl(`
    export const components = { Btn: (props) => ({ button: props }) }
    export const h = (tag, props, ...children) => ({ tag, props, children })
    export function applyDiff() {}
  `),
  'nostr-tools': dataUrl(`export function verifyEvent() { return true }`),
  wireweave: dataUrl(`
    export function createRelayPool() {
      return {
        connect() {},
        subscribe(id, filters, cb) { globalThis.__sbDeliver = cb; return id },
        status() { return [] },
        unsubscribe() {},
        disconnect() {},
      }
    }
  `),
}

const HOOK = dataUrl(`
  const STUBS = ${JSON.stringify(STUBS)};
  export async function resolve(specifier, context, next) {
    if (Object.hasOwn(STUBS, specifier)) return { url: STUBS[specifier], shortCircuit: true, format: 'module' };
    return next(specifier, context);
  }
`)
register(HOOK, import.meta.url)

const makeElement = (tag) => ({
  tag,
  className: '',
  id: '',
  textContent: '',
  children: [],
  appendChild(child) { this.children.push(child); return child },
  addEventListener() {},
  remove() {},
  querySelector() { return { className: 'sb-card' } },
})
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById() { return null },
  createElement: makeElement,
}
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onerror?.()) }
  close() {}
}

const { createServerBrowser } = await import(pathToFileURL(join(ROOT, 'client', 'ServerBrowser.js')).href)
const sb = createServerBrowser({ namespace: 'spoint', relays: [] })
await sb.open()
const deliver = (event) => globalThis.__sbDeliver(event)

const now = Date.now()
const beacon = (pubkey, worldName, action, ts) => ({
  pubkey,
  tags: [['d', 'spoint-server:main'], ['ns', 'spoint']],
  content: JSON.stringify({ action, worldName, host: 'shared.example', port: 7000, players: 1, maxPlayers: 8, mode: 'default', ts }),
})
const dedicatedNames = () => sb._liveRows().filter((r) => r.kind === 'dedicated').map((r) => r.name).sort()
const expectNames = (want) => JSON.stringify(dedicatedNames()) === JSON.stringify(want)

const authorA = 'a'.repeat(64)
const authorB = 'b'.repeat(64)
const results = []
const check = (label, ok) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
}

console.log('stubs: anentrypoint-design, nostr-tools, wireweave, document, WebSocket (DOM and transport only; ServerBrowser.js logic is real)')

deliver(beacon(authorA, 'Alpha', 'online', now))
deliver(beacon(authorB, 'Beta', 'online', now))
check(`two hosts, same dTag and port, different authors are both listed (got ${JSON.stringify(dedicatedNames())})`, expectNames(['Alpha', 'Beta']))

deliver(beacon(authorA, 'Alpha', 'offline', now + 1))
check(`Alpha going offline leaves Beta listed (got ${JSON.stringify(dedicatedNames())})`, expectNames(['Beta']))

sb.dispose()
const pass = results.every(Boolean)
console.log(`RESULT: ${pass ? 'PASS' : 'FAIL'}`)
process.exitCode = pass ? 0 : 1
