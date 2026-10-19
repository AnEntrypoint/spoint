// Flies the camera in a circle around the planet in a headful browser and reports frame timing.
// The camera is taken over by the 'custom' controller mode, so only this probe moves it.
//
//   node scripts/planet-orbit-hitch-probe.mjs [--url=<game url>] [--seconds=60] [--alt=<m>] [--period=<s>]
//
// Prints one JSON object: frame-time percentiles, hitch counts (frames over 33.4 ms and 50 ms), and
// the worst frames with their offset into the run, so a hitch can be matched to what the camera was over.

import { chromium, DEFAULT_VIEWPORT } from './lib/cdp-browser.mjs'

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}
const url = arg('url') || 'https://anentrypoint.github.io/spoint/'
const seconds = Number(arg('seconds') || 60)
const altM = Number(arg('alt') || 40)
const periodS = Number(arg('period') || 45)

const ready = () => !!(window.__camera && window.__floatingOrigin && window.__camCtrl && window.__terrain?.frame)

const startOrbit = (o) => {
  const cam = window.__camera
  const fo = window.__floatingOrigin
  const ctrl = window.__camCtrl
  const R = window.__terrain.frame.radius
  const r = R + o.altM
  ctrl.setMode('custom')
  const dts = []
  const worst = []
  let t0 = null
  let last = null
  const step = now => {
    if (t0 === null) t0 = now
    const elapsed = now - t0
    const ang = (elapsed / 1000) / o.periodS * 2 * Math.PI
    const sh = fo.getShift()
    const cx = -sh.x, cy = -sh.y, cz = -sh.z
    cam.position.set(cx + r * Math.cos(ang), cy, cz + r * Math.sin(ang))
    cam.lookAt(cx, cy, cz)
    if (last !== null) {
      const dt = now - last
      dts.push(dt)
      if (dt > 33.4) worst.push({ atS: +(elapsed / 1000).toFixed(2), dtMs: +dt.toFixed(1), overMeters: 0 })
    }
    last = now
    if (elapsed < o.seconds * 1000) requestAnimationFrame(step)
    else window.__orbitResult = { dts, worst }
  }
  window.__orbitResult = null
  requestAnimationFrame(step)
  return { radiusM: R, orbitRadiusM: r }
}

const summarise = (dts, worst) => {
  const s = [...dts].sort((a, b) => a - b)
  const pct = p => s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2) : null
  return {
    frames: s.length,
    p50Ms: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99),
    maxMs: s.length ? +s[s.length - 1].toFixed(1) : null,
    over33ms: s.filter(d => d > 33.4).length,
    over50ms: s.filter(d => d > 50).length,
    worst: worst.sort((a, b) => b.dtMs - a.dtMs).slice(0, 12),
  }
}

const browser = await chromium.launch({ viewport: DEFAULT_VIEWPORT })
try {
  const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT })
  await page.goto(url, { waitUntil: 'load', timeout: 60000 })
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (await page.evaluate(ready)) break
    await page.waitForTimeout(500)
  }
  if (!(await page.evaluate(ready))) throw new Error('game globals never appeared (camera, floating origin, camera controller, terrain frame)')
  const started = await page.evaluate(startOrbit, { altM, periodS, seconds })
  await page.waitForTimeout((seconds + 2) * 1000)
  const result = await page.evaluate(() => window.__orbitResult)
  if (!result) throw new Error('orbit never finished; the page stopped driving frames')
  const summary = summarise(result.dts, result.worst)
  console.log(JSON.stringify({ url, seconds, altM, periodS, ...started, ...summary }, null, 2))
} finally {
  await browser.close()
}
