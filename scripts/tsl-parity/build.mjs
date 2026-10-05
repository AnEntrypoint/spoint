import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { bootBody, settleBody, captureBody, leftEdgeBody, dryParse } from './bodies.mjs'

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
const extras = process.argv.slice(2).filter(a => a.startsWith('--extra=')).map(a => { const [k, ...v] = a.slice('--extra='.length).split('='); return [k, v.join('=')] })
if (!args.out || !args.session) {
  console.error('usage: node scripts/tsl-parity/build.mjs --out=<dir> --session=<gm session id> [--pose=-2750,-750] [--min-veg=225] [--host=http://localhost:3000] [--extra=__hookName=<js value>]...')
  process.exit(2)
}
const pose = args.pose || '-2750,-750'
const minVeg = Number(args['min-veg'] || 225)
const host = args.host || 'http://localhost:3000'
const stamp = Date.now()
const url = (legacy, tag) => `${host}/?singleplayer&terrainhash=1${legacy ? '&legacygl=1' : ''}&at=${pose}&v=${tag}${stamp}`
const session = args.session
const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()

const bodies = {
  'tsl-boot': bootBody({ session, url: url(false, 't'), minVeg }),
  'tsl-settle': settleBody({ session, minVeg }),
  'tsl-capture': captureBody({ session }),
  'tsl-left-edge': leftEdgeBody({ session, extraGlobals: extras }),
  'legacy-boot': bootBody({ session, url: url(true, 'l'), minVeg }),
  'legacy-settle': settleBody({ session, minVeg }),
  'legacy-capture': captureBody({ session }),
  'legacy-left-edge': leftEdgeBody({ session, extraGlobals: extras }),
  'tsl-geomorph-off-boot': bootBody({ session, url: url(false, 'g'), minVeg, flags: 'window.__geomorphLod=false;' }),
  'tsl-geomorph-off-capture': captureBody({ session, prefix: 'gm0-', withSky: false })
}
fs.mkdirSync(args.out, { recursive: true })
const report = {}
for (const [name, body] of Object.entries(bodies)) {
  report[name] = { params: dryParse(body), bytes: Buffer.byteLength(body) }
  fs.writeFileSync(path.join(args.out, name + '.cdp.txt'), body)
}
const order = [
  'session new gpu=<gpu> keep_alive',
  'tsl-boot  (repeat tsl-settle while the result says settle:false)',
  'tsl-capture',
  'tsl-left-edge (optional)',
  'legacy-boot  (repeat legacy-settle while settle:false)',
  'legacy-capture',
  'legacy-left-edge (optional)',
  'tsl-geomorph-off-boot, tsl-geomorph-off-capture (optional)',
  'session close-all',
  'node scripts/tsl-parity/analyze.mjs --gpu=<gpu> --dir=<dir holding the saved out-files named <body>.json>'
]
fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify({ head, pose, minVeg, host, extras, built: new Date(stamp).toISOString(), order, bodies: report }, null, 1))
console.log(JSON.stringify({ out: args.out, head, bodies: report }, null, 1))
