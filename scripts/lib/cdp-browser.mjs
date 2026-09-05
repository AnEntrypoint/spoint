// cdp-browser.mjs -- playwright-free chromium driver over raw CDP.
//
// Why this exists: playwright is deliberately NOT a dependency of this repo. The gm `browser` verb is
// the sanctioned interactive browser surface; for headless CI gates that must run under `node
// scripts/<gate>.mjs`, this module is the single shared driver. It speaks CDP directly over a
// WebSocket, exactly like scripts/lib/gpu-eval.mjs already did for the GPU probes -- this is that
// same transport generalised to the page-interaction surface the CI gates need (mouse, keyboard,
// multiple independent contexts, pageerror capture).
//
// Deliberately a SMALL surface: only what the real gates use, mirroring playwright's method names so
// the gate bodies read unchanged. Anything beyond that belongs in the browser verb, not here.
//
//   import { launch } from './lib/cdp-browser.mjs'
//   const browser = await launch()
//   const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
//   await page.goto('http://localhost:8090/')
//   const v = await page.evaluate(() => window.__app?.ready)
//   await browser.close()

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Locate a chromium/chrome binary WITHOUT playwright. CHROME env wins (CI sets it explicitly);
// otherwise probe the standard per-platform install locations. The ms-playwright cache is still
// read as a last resort so a developer machine that happens to have one keeps working, but nothing
// installs or requires it.
export function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean)
  for (const p of candidates) { try { if (fs.existsSync(p)) return p } catch (_) {} }
  // Last resort only -- a pre-existing cache is usable, but is never provisioned by this repo.
  // PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers are probed too: a Playwright-provisioned image
  // (CI runners, this sandbox) puts the browser THERE and leaves ~/.cache/ms-playwright absent,
  // so without these two entries findChrome() returned null and every browser-driven gate
  // (cold-load, frame-time, terrain-camera-stress, gpu-eval) failed to launch at all.
  for (const base of [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(os.homedir(), 'AppData/Local/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean)) {
    try {
      const dirs = fs.readdirSync(base).filter(d => /^chromium(_headless_shell)?-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()))
      for (const d of dirs) {
        for (const rel of ['chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
          const exe = path.join(base, d, rel)
          if (fs.existsSync(exe)) return exe
        }
      }
    } catch (_) {}
  }
  return null
}

// How long to wait for a freshly-spawned chrome to write DevToolsActivePort.
//
// 20s was enough on a warm dev machine and NOT enough on a cold CI runner,
// which failed with "chrome did not expose a CDP port within 20s" on a commit
// whose only change was a .gm/prd.yml edit -- i.e. pure startup variance, not a
// code regression. First launch on a fresh runner pays cold page cache and a
// freshly-created profile directory, so the budget has to cover the slow case
// rather than the observed-once fast one.
//
// Overridable because "slow machine" is environmental, not something the repo
// can know: a loaded shared runner may legitimately need more.
const CDP_PORT_TIMEOUT_MS = Number(process.env.CDP_PORT_TIMEOUT_MS || 60000)

const wait = (ms) => new Promise(r => setTimeout(r, ms))

// A global `WebSocket` only exists from Node 22 onward. CI pins Node 20, where
// referencing it throws `ReferenceError: WebSocket is not defined` -- which is
// exactly how this surfaced: green on a Node 24 dev machine, red in CI. Fall
// back to the `ws` package (already a real dependency of this repo, used by the
// server) so the driver works across both.
//
// Resolved once at module load rather than per-call, so a missing implementation
// fails loudly at import with a message naming the cause, instead of throwing a
// bare ReferenceError from deep inside a connection attempt.
async function resolveWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket
  try {
    const mod = await import('ws')
    return mod.default || mod.WebSocket
  } catch (e) {
    throw new Error(
      `no WebSocket implementation available: this Node (${process.version}) has no global WebSocket ` +
      `and the 'ws' package could not be imported (${e.message}). Node 22+ provides one natively.`,
    )
  }
}

const waitFor = (fn, ms, every = 200) => new Promise((res, rej) => {
  const t0 = Date.now()
  const tick = async () => {
    try { const v = await fn(); if (v) return res(v) } catch (_) {}
    if (Date.now() - t0 > ms) return rej(new Error('timeout'))
    setTimeout(tick, every)
  }
  tick()
})

// Serialize a page.evaluate argument the same way playwright does: a function (with optional arg) or
// a bare expression string. Returns an expression string CDP can evaluate.
function toExpression(fn, arg) {
  if (typeof fn === 'function') return `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
  return String(fn)
}

class Page {
  constructor(conn, sessionId, targetId) {
    this._conn = conn
    this._sid = sessionId
    this._targetId = targetId
    this._errorHandlers = []
    this._closed = false
    this.mouse = new Mouse(this)
    this.keyboard = new Keyboard(this)
  }

  _send(method, params = {}) { return this._conn.send(method, params, this._sid) }

  // Only 'pageerror' is supported -- it is the one event the real gates subscribe to.
  on(event, handler) {
    if (event === 'pageerror') this._errorHandlers.push(handler)
    return this
  }

  _emitPageError(err) { for (const h of this._errorHandlers) { try { h(err) } catch (_) {} } }

  async setViewport({ width, height }) {
    await this._send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {})
  }

  async goto(url, opts = {}) {
    const waitUntil = opts.waitUntil || 'load'
    await this._send('Page.navigate', { url })
    // domcontentloaded/load both resolve off the lifecycle stream; fall back to a bounded settle so a
    // gate never hangs forever on a page that never fires the exact event.
    const target = waitUntil === 'domcontentloaded' ? 'DOMContentLoaded' : 'load'
    await waitFor(() => this._conn._lifecycle.get(this._sid)?.has(target), opts.timeout || 30000, 100).catch(() => {})
    return null
  }

  async evaluate(fn, arg) {
    const expression = `(async()=>{ return (${toExpression(fn, arg)}); })()`
    const r = await this._send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed'
      throw new Error(msg)
    }
    return r.result?.value
  }

  async waitForTimeout(ms) { await wait(ms) }

  async screenshot(opts = {}) {
    const r = await this._send('Page.captureScreenshot', { format: 'png' })
    const buf = Buffer.from(r.data, 'base64')
    if (opts.path) fs.writeFileSync(opts.path, buf)
    return buf
  }

  async close() {
    if (this._closed) return
    this._closed = true
    await this._conn.send('Target.closeTarget', { targetId: this._targetId }).catch(() => {})
  }
}

// CDP dispatchMouseEvent wrapper matching the playwright mouse surface the gates use.
class Mouse {
  constructor(page) { this._page = page; this._x = 0; this._y = 0; this._down = false }
  async move(x, y) {
    this._x = x; this._y = y
    await this._page._send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: this._down ? 'left' : 'none', buttons: this._down ? 1 : 0,
    })
  }
  async down(opts = {}) {
    this._down = true
    await this._page._send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: this._x, y: this._y, button: opts.button || 'left', buttons: 1, clickCount: 1,
    })
  }
  async up(opts = {}) {
    this._down = false
    await this._page._send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: this._x, y: this._y, button: opts.button || 'left', buttons: 0, clickCount: 1,
    })
  }
  async click(x, y, opts = {}) {
    await this.move(x, y)
    await this.down(opts)
    await this.up(opts)
  }
}

// Minimal key mapping: the gates drive movement keys (KeyW/KeyA/KeyS/KeyD) and the odd letter key.
const KEY_DEFS = {
  KeyW: { key: 'w', text: 'w', keyCode: 87 }, KeyA: { key: 'a', text: 'a', keyCode: 65 },
  KeyS: { key: 's', text: 's', keyCode: 83 }, KeyD: { key: 'd', text: 'd', keyCode: 68 },
  KeyE: { key: 'e', text: 'e', keyCode: 69 }, KeyC: { key: 'c', text: 'c', keyCode: 67 },
  Space: { key: ' ', text: ' ', keyCode: 32 }, ShiftLeft: { key: 'Shift', keyCode: 16 },
}

class Keyboard {
  constructor(page) { this._page = page }
  _def(code) {
    const d = KEY_DEFS[code]
    if (d) return { code, ...d }
    // Fall back to a single-character key so an unmapped code still dispatches something real.
    const ch = code.startsWith('Key') ? code.slice(3).toLowerCase() : code
    return { code, key: ch, text: ch.length === 1 ? ch : undefined, keyCode: ch.toUpperCase().charCodeAt(0) || 0 }
  }
  async down(code) {
    const d = this._def(code)
    await this._page._send('Input.dispatchKeyEvent', {
      type: d.text ? 'keyDown' : 'rawKeyDown', code: d.code, key: d.key, text: d.text,
      windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode,
    })
  }
  async up(code) {
    const d = this._def(code)
    await this._page._send('Input.dispatchKeyEvent', {
      type: 'keyUp', code: d.code, key: d.key, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode,
    })
  }
  async press(code, opts = {}) {
    await this.down(code)
    if (opts.delay) await wait(opts.delay)
    await this.up(code)
  }
}

// A BrowserContext maps to a real CDP browser context, giving the same isolation (separate storage,
// separate session) that the two-client e2e gate depends on.
class BrowserContext {
  constructor(browser, browserContextId, viewport) {
    this._browser = browser
    this._id = browserContextId
    this._viewport = viewport
  }
  async newPage(opts = {}) {
    return this._browser._newPage({ ...opts, viewport: opts.viewport || this._viewport, browserContextId: this._id })
  }
  async close() {
    if (!this._id) return
    await this._browser._conn.send('Target.disposeBrowserContext', { browserContextId: this._id }).catch(() => {})
  }
}

class Browser {
  constructor(conn, proc, profileDir) {
    this._conn = conn
    this._proc = proc
    this._profileDir = profileDir
    this._pages = []
  }

  async newContext(opts = {}) {
    const { browserContextId } = await this._conn.send('Target.createBrowserContext', {})
    return new BrowserContext(this, browserContextId, opts.viewport)
  }

  async newPage(opts = {}) { return this._newPage(opts) }

  async _newPage(opts = {}) {
    const params = { url: 'about:blank' }
    if (opts.browserContextId) params.browserContextId = opts.browserContextId
    const { targetId } = await this._conn.send('Target.createTarget', params)
    const { sessionId } = await this._conn.send('Target.attachToTarget', { targetId, flatten: true })
    const page = new Page(this._conn, sessionId, targetId)
    this._conn._pages.set(sessionId, page)
    this._conn._lifecycle.set(sessionId, new Set())
    await this._conn.send('Runtime.enable', {}, sessionId)
    await this._conn.send('Page.enable', {}, sessionId)
    await this._conn.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId).catch(() => {})
    if (opts.viewport) await page.setViewport(opts.viewport)
    this._pages.push(page)
    return page
  }

  async close() {
    try { this._conn.close() } catch (_) {}
    try { this._proc.kill() } catch (_) {}
    // Give chrome a moment to release the profile dir before removing it.
    await wait(150)
    try { fs.rmSync(this._profileDir, { recursive: true, force: true }) } catch (_) {}
  }
}

class Connection {
  constructor(ws) {
    this._ws = ws
    this._seq = 0
    this._pend = new Map()
    this._pages = new Map()
    this._lifecycle = new Map()
    ws.onmessage = (ev) => this._onMessage(ev)
  }

  _onMessage(ev) {
    let m
    try { m = JSON.parse(ev.data) } catch (_) { return }
    if (m.id && this._pend.has(m.id)) {
      const { res, rej } = this._pend.get(m.id)
      this._pend.delete(m.id)
      return m.error ? rej(new Error(m.error.message || JSON.stringify(m.error))) : res(m.result)
    }
    if (!m.method) return
    const sid = m.sessionId
    if (m.method === 'Page.lifecycleEvent' && sid) {
      const set = this._lifecycle.get(sid)
      if (set) set.add(m.params?.name === 'DOMContentLoaded' ? 'DOMContentLoaded' : m.params?.name === 'load' ? 'load' : m.params?.name)
    }
    // Surface uncaught page exceptions to any registered pageerror handler.
    if (m.method === 'Runtime.exceptionThrown' && sid) {
      const page = this._pages.get(sid)
      if (page) {
        const d = m.params?.exceptionDetails
        page._emitPageError(new Error(d?.exception?.description || d?.text || 'page error'))
      }
    }
  }

  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const id = ++this._seq
      this._pend.set(id, { res, rej })
      const msg = sessionId ? { id, method, params, sessionId } : { id, method, params }
      try { this._ws.send(JSON.stringify(msg)) } catch (e) { this._pend.delete(id); rej(e) }
    })
  }

  close() { try { this._ws.close() } catch (_) {} }
}

// Launch headless chromium and return a playwright-shaped Browser handle.
// opts: { headless=true, args=[] }
export async function launch(opts = {}) {
  const chrome = findChrome()
  if (!chrome) {
    throw new Error('no chromium/chrome binary found. Set CHROME=/path/to/chrome (this repo does not depend on playwright).')
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoint-cdp-'))
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    ...(opts.args || []),
    'about:blank',
  ]
  const proc = spawn(chrome, args, { stdio: 'ignore' })
  const portFile = path.join(profileDir, 'DevToolsActivePort')
  const dport = await waitFor(
    () => (fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]) : null),
    CDP_PORT_TIMEOUT_MS, 100,
  ).catch(() => {
    try { proc.kill() } catch (_) {}
    throw new Error(
      `chrome did not expose a CDP port within ${CDP_PORT_TIMEOUT_MS}ms ` +
      `(binary: ${chrome}). Raise CDP_PORT_TIMEOUT_MS if this is a slow/cold machine.`,
    )
  })
  const ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json()
  const WS = await resolveWebSocket()
  const ws = new WS(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed to open')) })
  const conn = new Connection(ws)
  await conn.send('Target.setDiscoverTargets', { discover: true }).catch(() => {})
  return new Browser(conn, proc, profileDir)
}

// Named export mirroring playwright's `chromium` object so call sites read identically.
export const chromium = { launch }
