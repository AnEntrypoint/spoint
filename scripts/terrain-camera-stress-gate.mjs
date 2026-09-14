#!/usr/bin/env node
import { chromium } from './lib/cdp-browser.mjs'

const PORT = 20000 + Math.floor(Math.random() * 20000)

const PASS = []
const FAIL = []
function check(label, cond, detail) {
  if (cond) { PASS.push(label); console.log(`  [PASS] ${label}`) }
  else { FAIL.push(label); console.log(`  [FAIL] ${label}${detail ? ' -- ' + detail : ''}`) }
}

async function main() {
  process.env.WORLD = 'tps-game'
  process.env.PORT = String(PORT)
  process.env.SPOINT_SKIP_PREWARM = '1'
  process.env.SPOINT_NO_WATCH = '1'
  console.log(`[terrain-camera-stress] booting real server on port ${PORT} (world=tps-game, prewarm+watchers skipped)...`)
  const { boot } = await import('../src/sdk/server.js')
  const server = await boot()
  console.log('[terrain-camera-stress] server up.')

  let browser
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-gl=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] })
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })

    await page.goto(`http://localhost:${PORT}/?multiplayer&world=tps-game`)

    console.log('[terrain-camera-stress] waiting for scene to be ready...')
    const start = Date.now()
    let ready = false
    while (Date.now() - start < 90000) {
      ready = await page.evaluate(() => !!(window.__app && window.__app.scene)).catch(() => false)
      if (ready) break
      await new Promise(r => setTimeout(r, 300))
    }
    check('scene became ready within 90s', ready)
    if (!ready) throw new Error('scene never became ready -- aborting before the crash-repro sequence')

    await page.mouse.click(400, 300).catch(() => {})
    await page.waitForTimeout(300)

    const before = await page.evaluate(() => {
      const info = window.__app && window.__app.renderer && window.__app.renderer.info
      return info ? { geometries: info.memory.geometries, textures: info.memory.textures } : null
    }).catch(() => null)
    console.log('[terrain-camera-stress] pre-pan resource baseline:', JSON.stringify(before))

    console.log('[terrain-camera-stress] driving the aggressive camera-pan repro sequence (150px amplitude, 60ms interval, held drag, ~2.5s)...')
    let crashed = false
    let crashMessage = null
    try {
      await page.mouse.move(400, 300)
      await page.mouse.down()
      for (let i = 0; i < 25; i++) {
        await page.mouse.move(400 + Math.sin(i * 0.3) * 150, 300 + Math.cos(i * 0.2) * 80)
        await page.waitForTimeout(60)
      }
      await page.mouse.up()
      await page.waitForTimeout(500)
    } catch (e) {
      crashed = true
      crashMessage = String(e && e.message || e)
    }
    check('page survived the aggressive camera-pan sequence without a renderer crash', !crashed, crashMessage || '')

    if (!crashed) {
      const responsive = await page.evaluate(() => 1 + 1).then(v => v === 2).catch(() => false)
      check('page is still responsive to page.evaluate after the pan sequence', responsive)

      const after = await page.evaluate(() => {
        const info = window.__app && window.__app.renderer && window.__app.renderer.info
        return info ? { geometries: info.memory.geometries, textures: info.memory.textures } : null
      }).catch(() => null)
      console.log('[terrain-camera-stress] post-pan resource counts:', JSON.stringify(after))

      const GEOMETRY_CAP = 400
      const TEXTURE_CAP = 400
      const boundedGeometries = after && Number.isFinite(after.geometries) && after.geometries < GEOMETRY_CAP
      const boundedTextures = after && Number.isFinite(after.textures) && after.textures < TEXTURE_CAP
      check(`geometries count stayed under ${GEOMETRY_CAP} after the pan burst`, boundedGeometries, after ? `got ${after.geometries}` : 'no renderer.info readback')
      check(`textures count stayed under ${TEXTURE_CAP} after the pan burst`, boundedTextures, after ? `got ${after.textures}` : 'no renderer.info readback')
    }
  } finally {
    if (browser) await browser.close()
    server.stop()
  }

  console.log(`\n[terrain-camera-stress] ${PASS.length} passed, ${FAIL.length} failed`)
  if (FAIL.length) { console.log('[terrain-camera-stress] FAILED CHECKS:', FAIL.join(', ')); process.exitCode = 1 }
  else process.exitCode = 0
}

main().catch(err => {
  console.error('[terrain-camera-stress] fatal error:', err)
  process.exitCode = 1
})
