#!/usr/bin/env node
// The owner's report is "the display changes size the whole time during testing on the
// browser". This witness measures the two numbers behind that: the OS window rectangle
// (what the operator sees) and the page viewport (what the page lays out), for every
// launch shape the tree uses. A page whose viewport does not fit the window's content
// area is scaled to fit, so `fit` below is the ratio between one CSS page pixel and one
// screen pixel: anything under 1 is a picture drawn smaller than it was laid out.
//
// Two modes:
//   --arms=<a,b,c>   launch the named shapes in sequence and measure each one directly.
//   --watch=<cmd>    run <cmd> as a child and sample the OS window of every chrome the
//                    child starts, plus each page's innerWidth over CDP. This is the
//                    mode that measures a real witness unmodified.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPO = path.resolve(HERE, '..')
const { chromium, DEFAULT_VIEWPORT, windowSizeFor } = await import(pathToFileURL(path.join(HERE, 'lib', 'cdp-browser.mjs')).href)

const arg = (k, d) => { const h = process.argv.find((a) => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d }
const ARMS = String(arg('arms', 'page,pageNamed,ctx,ctxNamed,launchVp,winsize,fit1080')).split(',').filter(Boolean)
const WATCH = arg('watch', null)
const SETTLE_MS = Number(arg('settle', 1200))
const SAMPLE_MS = Number(arg('sample-ms', 400))
// The box has one accelerated browser session and a sibling lane can hold it for a
// long time, so the default wait is generous: a witness that gives up reports an
// error, and an error is not a measurement.
const LEASE_WAIT_MS = Number(arg('lease-wait-ms', 600000))

const PS_ALL_WINDOWS = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
}
'@
Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -ne 0) {
    $r = New-Object RECT
    if ([W]::GetWindowRect($_.MainWindowHandle, [ref]$r)) {
      "$($_.Id) $($r.Right-$r.Left) $($r.Bottom-$r.Top)"
    }
  }
}
`

function chromeWindows() {
  if (process.platform !== 'win32') return []
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_ALL_WINDOWS], { encoding: 'utf8', timeout: 30000 })
  if (r.status !== 0) return []
  const out = []
  for (const line of String(r.stdout || '').split('\n')) {
    const p = line.trim().split(/\s+/).map(Number)
    if (p.length === 3 && p.every((n) => Number.isFinite(n)) && p[1] > 0 && p[2] > 0) out.push({ pid: p[0], w: p[1], h: p[2] })
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- watch mode

function devtoolsPorts() {
  const root = path.join(REPO, '.gm', 'browser-lease')
  const ports = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let ents = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'DevToolsActivePort') {
        try { ports.push(Number(String(fs.readFileSync(p, 'utf8')).split('\n')[0].trim())) } catch (_) {}
      }
    }
  }
  walk(root, 0)
  return ports.filter((n) => Number.isInteger(n) && n > 0)
}

async function pageInnersOverCdp() {
  const out = []
  for (const port of devtoolsPorts()) {
    let ws = null
    try {
      const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
      const WS = typeof globalThis.WebSocket === 'function' ? globalThis.WebSocket : (await import('ws')).default
      ws = new WS(ver.webSocketDebuggerUrl)
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws open failed')) })
      let id = 0
      const pend = new Map()
      ws.onmessage = (ev) => {
        let m
        try { m = JSON.parse(ev.data) } catch (_) { return }
        if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) }
      }
      const send = (method, params, sessionId) => new Promise((res) => {
        const i = ++id
        pend.set(i, res)
        try { ws.send(JSON.stringify({ id: i, method, params, sessionId })) } catch (_) { pend.delete(i); res(null) }
      })
      const t = await send('Target.getTargets')
      for (const target of ((t && t.targetInfos) || []).filter((x) => x.type === 'page')) {
        const att = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        if (!att || !att.sessionId) continue
        const r = await send('Runtime.evaluate', {
          expression: 'JSON.stringify([window.innerWidth,window.innerHeight])',
          returnByValue: true,
        }, att.sessionId)
        if (r && r.result && typeof r.result.value === 'string') out.push(r.result.value)
      }
    } catch (_) {}
    try { ws && ws.close() } catch (_) {}
  }
  return out
}

async function watch(cmd) {
  const before = new Set(chromeWindows().map((w) => w.pid))
  const child = spawn(cmd, { shell: true, stdio: ['ignore', 'ignore', 'inherit'], cwd: REPO })
  const seen = new Map() // "WxH" -> count
  const inners = new Set()
  let polls = 0
  const t0 = Date.now()
  while (true) {
    const done = child.exitCode !== null || child.signalCode !== null
    for (const w of chromeWindows()) {
      if (before.has(w.pid)) continue
      const key = w.w + 'x' + w.h
      seen.set(key, (seen.get(key) || 0) + 1)
    }
    for (const v of await pageInnersOverCdp()) inners.add(v)
    polls++
    if (done) break
    if (Date.now() - t0 > Number(arg('watch-timeout-ms', 900000))) { child.kill(); break }
    await sleep(SAMPLE_MS)
  }
  const code = child.exitCode
  const windows = [...seen.keys()].sort()
  console.log('[window-size] watch cmd=' + JSON.stringify(cmd))
  console.log('[window-size]   exit=' + code + ' polls=' + polls + ' elapsedMs=' + (Date.now() - t0))
  console.log('[window-size]   OS window size(s) of every chrome this run opened: ' + JSON.stringify(windows) + ' samples=' + JSON.stringify([...seen.values()]))
  console.log('[window-size]   page innerWidth/innerHeight seen over CDP: ' + JSON.stringify([...inners].sort()))
  return { windows, inners: [...inners], code }
}

// ---------------------------------------------------------------- arms mode

// Every shape a witness in this tree uses to open a surface. fit1080 is the one shape
// that deliberately asks for more than the default: it exists to show the window grows
// to fit instead of scaling the page down, and it is reported outside the constancy set.
function armShape(name) {
  const L = (extra) => chromium.launch({ owner: 'window-size-constancy-' + process.pid, leaseWaitMs: LEASE_WAIT_MS, ...extra })
  if (name === 'page') return { launch: () => L({}), page: (b) => b.newPage(), constancy: true }
  if (name === 'pageNamed') return { launch: () => L({}), page: (b) => b.newPage({ viewport: DEFAULT_VIEWPORT }), constancy: true }
  if (name === 'ctx') return { launch: () => L({}), page: async (b) => (await b.newContext()).newPage(), constancy: true }
  if (name === 'ctxNamed') return { launch: () => L({}), page: async (b) => (await b.newContext({ viewport: DEFAULT_VIEWPORT })).newPage(), constancy: true }
  if (name === 'launchVp') return { launch: () => L({ viewport: DEFAULT_VIEWPORT }), page: (b) => b.newPage(), constancy: true }
  if (name === 'winsize') return { launch: () => L({ args: ['--window-size=1280,810'] }), page: (b) => b.newPage({ viewport: DEFAULT_VIEWPORT }), constancy: true }
  if (name === 'fit1080') return { launch: () => L({}), page: (b) => b.newPage({ viewport: { width: Math.round(DEFAULT_VIEWPORT.width * 1.5), height: Math.round(DEFAULT_VIEWPORT.height * 1.5) } }), constancy: false }
  throw new Error('unknown arm ' + name)
}

async function cdpWindowBounds(browser, targetId) {
  try {
    const { windowId, bounds } = await browser._conn.send('Browser.getWindowForTarget', { targetId })
    return { windowId, ...bounds }
  } catch (e) { return { error: String(e.message || e).slice(0, 160) } }
}

const FRAME = (() => {
  const s = windowSizeFor(DEFAULT_VIEWPORT)
  return { w: s.width - DEFAULT_VIEWPORT.width, h: s.height - DEFAULT_VIEWPORT.height }
})()

const rows = []
for (const name of ARMS) {
  const shape = armShape(name)
  let browser = null
  try {
    browser = await shape.launch()
    await sleep(SETTLE_MS)
    const page = await shape.page(browser)
    await sleep(400)
    const inner = await page.evaluate(() => [window.innerWidth, window.innerHeight])
    const scr = await page.evaluate(() => [window.screen.width, window.screen.height, window.devicePixelRatio])
    const scale = await page.evaluate(() => (window.visualViewport ? window.visualViewport.scale : null))
    const rect = chromeWindows().find((w) => w.pid === browser.pid) || chromeWindows()[0] || null
    const bounds = await cdpWindowBounds(browser, page._targetId)
    const row = {
      arm: name,
      constancy: shape.constancy,
      osWindow: rect ? rect.w + 'x' + rect.h : null,
      cdpBounds: bounds && bounds.width ? bounds.width + 'x' + bounds.height : bounds,
      pageInner: inner[0] + 'x' + inner[1],
      // one screen pixel per CSS page pixel; under 1 means Chrome scaled the page down
      fit: rect ? Number(Math.min((rect.w - FRAME.w) / inner[0], (rect.h - FRAME.h) / inner[1]).toFixed(4)) : null,
      visualViewportScale: scale,
      screen: scr[0] + 'x' + scr[1] + '@' + scr[2],
      pid: browser.pid,
    }
    rows.push(row)
    console.log('[window-size] ' + JSON.stringify(row))
  } catch (e) {
    const row = { arm: name, constancy: shape.constancy, error: String(e.message || e).slice(0, 300) }
    rows.push(row)
    console.log('[window-size] ' + JSON.stringify(row))
  } finally {
    if (browser) await browser.close().catch(() => {})
    await sleep(600)
  }
}

let pass = true
const summary = []

if (WATCH) {
  const w = await watch(WATCH)
  summary.push('watch=' + JSON.stringify(w.windows))
  if (w.windows.length !== 1) pass = false
} else {
  const set = rows.filter((r) => r.constancy && !r.error)
  const errors = rows.filter((r) => r.error)
  const windows = [...new Set(set.map((r) => r.osWindow))]
  const inners = [...new Set(set.map((r) => r.pageInner))]
  const bounds = [...new Set(set.map((r) => r.cdpBounds))]
  const fits = [...new Set(set.map((r) => r.fit))]
  console.log('[window-size] MEASURED distinct OS window size(s): ' + JSON.stringify(windows) + ' over ' + set.length + ' launch(es)')
  console.log('[window-size] MEASURED distinct CDP window bound(s): ' + JSON.stringify(bounds) + ' over ' + set.length + ' launch(es)')
  console.log('[window-size] MEASURED distinct page viewport(s): ' + JSON.stringify(inners) + ' over ' + set.length + ' launch(es)')
  console.log('[window-size] MEASURED fit value(s): ' + JSON.stringify(fits))
  const fitArms = rows.filter((r) => !r.constancy && !r.error)
  for (const r of fitArms) console.log('[window-size] non-default shape ' + r.arm + ': osWindow=' + r.osWindow + ' pageInner=' + r.pageInner + ' fit=' + r.fit)
  const constant = windows.length === 1 && inners.length === 1 && bounds.length === 1 && errors.length === 0
  const unscaled = set.every((r) => r.fit >= 1)
  console.log(constant
    ? '[window-size] CONSTANT: OS window ' + windows[0] + ', page viewport ' + inners[0] + ', over ' + set.length + ' launch shapes'
    : '[window-size] NOT CONSTANT')
  summary.push('window=' + JSON.stringify(windows) + ' viewport=' + JSON.stringify(inners) + ' fit=' + JSON.stringify(fits))
  pass = constant && unscaled && (fitArms.length === 0 || fitArms.every((r) => r.fit >= 1))
}

console.log('[window-size] SUMMARY ' + summary.join(' '))
console.log(pass ? '[window-size] RESULT: PASS' : '[window-size] RESULT: FAIL')
process.exit(pass ? 0 : 1)
