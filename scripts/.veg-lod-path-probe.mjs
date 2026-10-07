import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

process.env.PORT = String(41000 + Math.floor(Math.random() * 1000))
process.env.WORLD = 'tps-game'
process.env.SPOINT_NO_WATCH = '1'
process.env.SPOINT_SKIP_PREWARM = '1'
const { boot } = await import(pathToFileURL(resolve('src', 'sdk', 'server.js')).href)
const server = await boot()
const port = process.env.PORT
const paths = [
  '/app.js',
  '/core/WebGPULodInstancer.js',
  '/client/core/WebGPULodInstancer.js',
  '/client/app.js',
  '/src/client/core/WebGPULodInstancer.js',
]
const out = []
for (const p of paths) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`)
    const body = await res.text()
    out.push({ p, status: res.status, type: res.headers.get('content-type'), bytes: body.length, head: body.slice(0, 80) })
  } catch (e) {
    out.push({ p, error: String(e && e.message || e) })
  }
}
console.log(JSON.stringify(out, null, 1))
try { await server.stop() } catch (_) {}
process.exit(0)
