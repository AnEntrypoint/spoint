#!/usr/bin/env node
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'
import { gpuModeFlag } from './lib/gpu-probe.mjs'
import { vendorLaunchArgs } from './lib/witness-gpu.mjs'
import { exitAfterQuiesce } from './lib/quiesce.mjs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 20000 + Math.floor(Math.random() * 20000)
const WORLD = 'e2e-ci-arena'
const EDITOR_CHUNK = /\/(EditorShell|editor)-[^/]+\.js$/
const BOOT_TIMEOUT_MS = 120000
const EDITOR_TIMEOUT_MS = 30000

const failures = []
const check = (name, ok, detail) => {
  console.log(`check ${name}: ${ok ? 'ok' : 'FAIL'} (${detail})`)
  if (!ok) failures.push(name)
}

process.env.WORLD = WORLD
process.env.PORT = String(PORT)
process.env.SPOINT_SKIP_PREWARM = '1'
process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_HOST = '127.0.0.1'
const { boot } = await import('../src/sdk/server.js')
const server = await boot()

let browser = null
let page = null
const pageErrors = []
let code = 1
try {
  browser = await chromium.launch({ args: vendorLaunchArgs(gpuModeFlag('gpu', 'software')) })
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT })
  page = await context.newPage()
  page.on('pageerror', e => pageErrors.push(String(e?.message || e)))

  await page.goto(`http://127.0.0.1:${PORT}/?world=${WORLD}&forcewebgl=1`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((timeoutMs) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (window.__app?.clientMachine?.isPlaying) return resolve(true)
      if (Date.now() > deadline) return reject(new Error('client never reached play'))
      setTimeout(tick, 100)
    }
    tick()
  }), BOOT_TIMEOUT_MS)

  const bootChunks = await page.evaluate(() => performance.getEntriesByType('resource').map(e => e.name))
  const editorAtBoot = bootChunks.filter(u => /\/(EditorShell|editor)-[^/]+\.js$/.test(u))
  check('boot-requests-no-editor-chunk', editorAtBoot.length === 0, `${editorAtBoot.length} editor chunk(s) fetched before play [${editorAtBoot.map(u => u.split('/').pop()).join(', ')}]`)

  const constructedAtBoot = await page.evaluate(() => ({ editor: window.__app?.editor != null, editPanel: window.__app?.editPanel != null }))
  check('editor-not-constructed-at-boot', !constructedAtBoot.editor && !constructedAtBoot.editPanel, `window.__app.editor=${constructedAtBoot.editor} editPanel=${constructedAtBoot.editPanel}`)
  check('no-page-errors-at-boot', pageErrors.length === 0, `${pageErrors.length} page error(s) ${pageErrors.slice(0, 3).join(' | ')}`)

  await page.keyboard.press('KeyP')
  const afterPress = await page.evaluate((timeoutMs) => new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const chunks = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\/(EditorShell|editor)-[^/]+\.js$/.test(u))
      const editing = window.__app?.clientMachine?.isEditor === true
      if (chunks.length && editing) return resolve({ chunks, editing })
      if (Date.now() > deadline) return resolve({ chunks, editing })
      setTimeout(tick, 100)
    }
    tick()
  }), EDITOR_TIMEOUT_MS)
  check('keyP-loads-editor-chunk', afterPress.chunks.length > 0, `${afterPress.chunks.length} editor chunk(s) fetched after KeyP [${afterPress.chunks.map(u => u.split('/').pop()).join(', ')}]`)
  check('keyP-enters-editor-mode', afterPress.editing === true, `clientMachine.isEditor=${afterPress.editing} after KeyP`)

  const constructedAfter = await page.evaluate(() => ({ editor: window.__app?.editor != null, editPanel: window.__app?.editPanel != null }))
  check('editor-constructed-after-keyP', constructedAfter.editor && constructedAfter.editPanel, `window.__app.editor=${constructedAfter.editor} editPanel=${constructedAfter.editPanel}`)
  check('no-page-errors-after-keyP', pageErrors.length === 0, `${pageErrors.length} page error(s) ${pageErrors.slice(0, 3).join(' | ')}`)

  code = failures.length === 0 ? 0 : 1
  console.log(code === 0
    ? `RESULT: PASS browser boot: no editor chunk fetched or constructed before play; KeyP fetched it and entered editor mode (${ROOT})`
    : `RESULT: FAIL browser boot: ${failures.join(', ')}`)
} catch (e) {
  const state = page ? await page.evaluate(() => ({ url: location.href, hasApp: !!window.__app, machine: window.__app?.clientMachine?.state?.value ?? window.__app?.clientMachine?.getSnapshot?.()?.value ?? null, isPlaying: window.__app?.clientMachine?.isPlaying ?? null })).catch(err => ({ evalError: String(err?.message || err) })) : null
  console.log('harness state: ' + JSON.stringify(state))
  console.log('harness page errors: ' + JSON.stringify(pageErrors.slice(0, 5)))
  console.log(`RESULT: FAIL browser boot: harness error: ${e?.message || e}`)
  code = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  server.stop()
}
await exitAfterQuiesce(code)
