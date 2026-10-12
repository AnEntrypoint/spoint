#!/usr/bin/env node
// Sky parity for the atmosphere LUT change: WebGPU/TSL arm vs legacy-GL arm, same pose, same LUT bytes.
//
// GPU witness: it launches a real accelerated headful Chrome through the project's shared browser
// lease (scripts/lib/cdp-browser.mjs) and boots a real WebGPURenderer page. It therefore CANNOT live
// in the gpu-free arm of scripts/check.mjs and is NOT wired into it: it runs only when
// SPOINT_GPU_WITNESS=1, which no CI job sets. Reported verdicts from this witness are local runs.
//
// usage: SPOINT_GPU_WITNESS=1 node scripts/gpulock.mjs run <owner> -- \
//          node scripts/atmosphere-lut-sky-parity-witness.mjs --host=http://localhost:3001 \
//          --out=.gm/pool/atm-lut-parity-r270-63 [--gpu=amd] [--pose=-2750,-750] [--min-veg=225]

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

if (process.env.SPOINT_GPU_WITNESS !== '1') {
  console.log('atmosphere-lut-sky-parity-witness SKIPPED: SPOINT_GPU_WITNESS!=1 (GPU witness; never in the gpu-free arm of scripts/check.mjs)')
  process.exit(0)
}

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
const host = args.host || 'http://localhost:3001'
const gpu = args.gpu || 'amd'
const pose = args.pose || '-2750,-750'
const minVeg = Number(args['min-veg'] || 225)
const out = resolve(ROOT, args.out || '.gm/pool/atm-lut-parity')
const stamp = Date.now()
const head = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()

const B = await import(pathToFileURL(resolve(HERE, 'tsl-parity', 'bodies.mjs')).href)
const { vendorGpuArgs } = await import(pathToFileURL(resolve(HERE, 'lib', 'gpu-probe.mjs')).href)
const { chromium } = await import(pathToFileURL(resolve(HERE, 'lib', 'cdp-browser.mjs')).href)

const launchArgs = vendorGpuArgs(gpu)
console.log('atmosphere-lut-sky-parity-witness gpu=' + gpu + ' adapterArgs=' + JSON.stringify(launchArgs.filter(a => a.includes('luid'))) + ' host=' + host + ' out=' + out)

fs.mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ root: ROOT, owner: 'atm-lut-sky-parity', args: launchArgs, leaseWaitMs: 180000, leaseTtlMs: 20 * 60 * 1000 })

const url = legacy => `${host}/?singleplayer&terrainhash=1${legacy ? '&legacygl=1' : ''}&at=${pose}&v=${legacy ? 'l' : 't'}${stamp}`

async function evalRaw(page, expression, timeout) {
  const r = await page._send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: timeout || 60000 })
  if (r && r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text || 'evaluate failed').slice(0, 400))
  return r && r.result ? r.result.value : null
}

async function runArm(name, legacy) {
  const page = await browser.newPage()
  const events = []
  page.on('Debugger.scriptParsed', p => { if (events.length < 600) events.push({ event: 'Debugger.scriptParsed', params: { url: p.url, hash: p.hash } }) })
  page.on('Runtime.exceptionThrown', p => { if (events.length < 600) events.push({ event: 'Runtime.exceptionThrown', params: p }) })
  await page._send('Debugger.enable', {}).catch(() => {})
  await page._send('Runtime.enable', {}).catch(() => {})
  await page._send('Input.setIgnoreInputEvents', { ignore: true }).catch(() => {})
  await page._send('Emulation.setDeviceMetricsOverride', JSON.parse(B.DEVICE_METRICS)).catch(() => {})
  await page._send('Network.enable', {}).catch(() => {})
  await page._send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {})
  await page._send('Network.clearBrowserCache', {}).catch(() => {})
  await page._send('Page.addScriptToEvaluateOnNewDocument', { source: B.inputBlockerHook('', head) })

  const bootResults = []
  const push = (arr, value) => arr.push({ result: { value: JSON.stringify(value) } })
  await page._send('Page.navigate', { url: url(legacy) })
  await new Promise(r => setTimeout(r, 1500))
  try { push(bootResults, JSON.parse(await evalRaw(page, B.postNavExpression()))) } catch (e) { bootResults.push({ error: 'postNav: ' + e.message }) }

  let settled = null
  for (let attempt = 0; attempt < 3 && !(settled && settled.settle); attempt++) {
    try { settled = JSON.parse(await evalRaw(page, B.settleExpression(minVeg), 130000)) } catch (e) { settled = { settle: false, reason: e.message } }
    push(bootResults, settled)
  }
  const renderer = settled && settled.gpu ? String(settled.gpu) : null
  const backend = settled && settled.backend ? String(settled.backend) : null
  console.log(name + ' settle=' + !!(settled && settled.settle) + ' veg=' + (settled && settled.veg) + ' backend=' + backend + ' gpu=' + renderer + ' canvas=' + JSON.stringify(settled && settled.canvas))
  if (!settled || !settled.settle) throw new Error(name + ': world never settled -- ' + JSON.stringify(settled && settled.reason || settled))
  if (!renderer) throw new Error(name + ': no window.__rendererInfo.glRenderer -- the adapter pin is not asserted, so this arm proves nothing')

  fs.writeFileSync(path.join(out, name + '-boot.json'), JSON.stringify({ ok: true, data: { results: bootResults, events } }))

  const cap = []
  try { push(cap, JSON.parse(await evalRaw(page, B.inputCountExpression('captureStart')))) } catch (e) { cap.push({ error: 'captureStart: ' + e.message }) }
  const frames = [
    ['skyPose', "window.__app.cam.restore({yaw:1.0,pitch:0.35,zoomIndex:2})", 2500, [['sky-a', B.SKY_CLIP], ['sky-b', B.SKY_CLIP], ['skyFull-a', B.FULL], ['skyFull-b', B.FULL]]],
    ['groundPose', "window.__app.cam.restore({yaw:1.0,pitch:0,zoomIndex:2})", 3000, [['ground-a', B.FULL], ['ground-b', B.FULL]]],
    ['greyStep', "window.__albedoOverride=[0.8,0.8,0.8,1]", 2000, [['grey-a', B.FULL], ['grey-b', B.FULL]]],
    ['relief1Step', "window.__reliefShade=1", 2000, [['greyRelief1-a', B.FULL], ['greyRelief1-b', B.FULL]]],
  ]
  for (const [step, assign, waitMs, shots] of frames) {
    try { push(cap, JSON.parse(await evalRaw(page, B.stepExpression(assign, waitMs, step), 60000))) } catch (e) { cap.push({ error: step + ': ' + e.message }) }
    for (const [label, clip] of shots) {
      try {
        const sig = JSON.parse(await evalRaw(page, B.signature(label)))
        cap.push({ result: { value: JSON.stringify(sig) } })
        const shot = await page._send('Page.captureScreenshot', { format: 'png', clip })
        cap.push({ data: shot.data })
      } catch (e) { cap.push({ error: label + ': ' + e.message }) }
    }
  }
  try { await evalRaw(page, B.stepExpression("delete window.__reliefShade;window.__albedoOverride=[0,0,0,0]", 1000, 'restored'), 30000) } catch (e) {}
  fs.writeFileSync(path.join(out, name + '-capture.json'), JSON.stringify({ ok: true, data: { results: cap, events: [] } }))
  await page.close()
  return { renderer, backend }
}

let verdict = 'FAIL'
try {
  const tsl = await runArm('tsl', false)
  const legacy = await runArm('legacy', true)
  console.log('arms tsl=' + JSON.stringify(tsl) + ' legacy=' + JSON.stringify(legacy))
  verdict = 'CAPTURED'
} catch (e) {
  console.log('atmosphere-lut-sky-parity-witness CAPTURE FAILED: ' + e.message)
  await browser.close().catch(() => {})
  console.log('RESULT: FAIL')
  process.exit(1)
}
await browser.close().catch(() => {})

console.log('--- scripts/tsl-parity/analyze.mjs (the project criterion: K=3 x same-renderer noise floor) ---')
let code = 1
try {
  const a = execFileSync(process.execPath, [resolve(HERE, 'tsl-parity', 'analyze.mjs'), '--gpu=' + gpu, '--dir=' + out], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(a.trim())
  code = 0
} catch (e) {
  console.log(String(e.stdout || '').trim())
  console.log(String(e.stderr || '').trim().slice(0, 800))
  code = e.status === undefined ? 1 : e.status
}
console.log('RESULT: ' + (code === 0 ? 'PASS' : 'FAIL') + ' capture=' + verdict + ' analyzeExit=' + code)
process.exit(code === 0 ? 0 : 1)
