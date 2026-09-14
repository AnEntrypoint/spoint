import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'

const RELAY_EXTERNAL = process.env.CDP_RELAY_EXTERNAL === '1' || (process.env.CDP_RELAY_EXTERNAL !== '0' && !!(process.env.HTTPS_PROXY || process.env.https_proxy))
const RELAY_CACHE_DIR = process.env.CDP_RELAY_CACHE || path.join(os.tmpdir(), 'spoint-cdp-relay')
function relayFetch(url) {
  const key = crypto.createHash('sha1').update(url).digest('hex')
  const bodyPath = path.join(RELAY_CACHE_DIR, key)
  const metaPath = bodyPath + '.meta.json'
  try {
    if (fs.existsSync(bodyPath) && fs.existsSync(metaPath)) {
      return { body: fs.readFileSync(bodyPath), meta: JSON.parse(fs.readFileSync(metaPath, 'utf8')) }
    }
  } catch (_) {}
  fs.mkdirSync(RELAY_CACHE_DIR, { recursive: true })
  const tmp = bodyPath + '.tmp'
  const r = spawnSync('curl', ['-sS', '-L', '--max-time', '60', '-o', tmp, '-w', '%{http_code} %{content_type}', url], { encoding: 'utf8' })
  if (r.status !== 0) { try { fs.unlinkSync(tmp) } catch (_) {} return null }
  const sp = (r.stdout || '').trim().indexOf(' ')
  const status = Number((r.stdout || '').trim().slice(0, sp)) || 0
  const contentType = (r.stdout || '').trim().slice(sp + 1) || 'application/octet-stream'
  if (status !== 200) { try { fs.unlinkSync(tmp) } catch (_) {} return { body: Buffer.alloc(0), meta: { status, contentType } } }
  fs.renameSync(tmp, bodyPath)
  const meta = { status, contentType }
  fs.writeFileSync(metaPath, JSON.stringify(meta))
  return { body: fs.readFileSync(bodyPath), meta }
}

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

const CDP_PORT_TIMEOUT_MS = Number(process.env.CDP_PORT_TIMEOUT_MS || 60000)

const wait = (ms) => new Promise(r => setTimeout(r, ms))

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

  on(event, handler) {
    if (event === 'pageerror') this._errorHandlers.push(handler)
    return this
  }

  _emitPageError(err) { for (const h of this._errorHandlers) { try { h(err) } catch (_) {} } }

  async _installExternalRelay() {
    await this._send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  }

  async _onRequestPaused(p) {
    const url = p.request?.url || ''
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url) || !/^https?:/.test(url)
    if (local) { await this._send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return }
    const res = relayFetch(url)
    if (!res) { await this._send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionReset' }).catch(() => {}); return }
    if (res.meta.status !== 200) { await this._send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: res.meta.status, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: '' }).catch(() => {}); return }
    await this._send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: res.meta.contentType },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      ],
      body: res.body.toString('base64'),
    }).catch(() => {})
  }

  async setViewport({ width, height }) {
    await this._send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {})
  }

  async goto(url, opts = {}) {
    const waitUntil = opts.waitUntil || 'load'
    await this._send('Page.navigate', { url })
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
    if (RELAY_EXTERNAL) await page._installExternalRelay()
    if (opts.viewport) await page.setViewport(opts.viewport)
    this._pages.push(page)
    return page
  }

  async close() {
    try { this._conn.close() } catch (_) {}
    try { this._proc.kill() } catch (_) {}
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
    if (m.method === 'Fetch.requestPaused' && sid) {
      const page = this._pages.get(sid)
      if (page) page._onRequestPaused(m.params).catch(() => {})
      return
    }
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

export const chromium = { launch }
