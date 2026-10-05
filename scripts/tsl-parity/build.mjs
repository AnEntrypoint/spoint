import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { bootBody, settleBody, captureBody, leftEdgeBody, dryParse } from './bodies.mjs'

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
const extras = process.argv.slice(2).filter(a => a.startsWith('--extra=')).map(a => { const [k, ...v] = a.slice('--extra='.length).split('='); return [k, v.join('=')] })
if (!args.out || !args.session) {
  console.error('usage: node scripts/tsl-parity/build.mjs --out=<dir> --session=<gm session id> [--pose=-2750,-750] [--min-veg=225] [--host=http://localhost:3000] [--forcewebgl=1] [--extra=__hookName=<js value>]...')
  process.exit(2)
}
const pose = args.pose || '-2750,-750'
const minVeg = Number(args['min-veg'] || 225)
const host = args.host || 'http://localhost:3000'
const stamp = Date.now()
const forceBackend = args.forcewebgl ? '&forcewebgl=1' : ''
const url = (legacy, tag) => `${host}/?singleplayer&terrainhash=1${legacy ? '&legacygl=1' : ''}${forceBackend}&at=${pose}&v=${tag}${stamp}`
const session = args.session
const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
const GPU_TOKENS = { nv: 'nvidia', 'nv-webgl2': 'nvidia', amd: 'amd', intel: 'intel', webgl2: 'nvidia', default: 'default' }
const bodySet = path.basename(path.resolve(args.out))
const verbGpu = args['verb-gpu'] || GPU_TOKENS[bodySet] || bodySet

const bodies = {
  'tsl-boot': bootBody({ session, url: url(false, 't'), minVeg, head }),
  'tsl-settle': settleBody({ session, minVeg }),
  'tsl-capture': captureBody({ session }),
  'tsl-left-edge': leftEdgeBody({ session, extraGlobals: extras }),
  'legacy-boot': bootBody({ session, url: url(true, 'l'), minVeg, head }),
  'legacy-settle': settleBody({ session, minVeg }),
  'legacy-capture': captureBody({ session }),
  'legacy-left-edge': leftEdgeBody({ session, extraGlobals: extras }),
  'tsl-geomorph-off-boot': bootBody({ session, url: url(false, 'g'), minVeg, flags: 'window.__geomorphLod=false;', head }),
  'tsl-geomorph-off-capture': captureBody({ session, prefix: 'gm0-', withSky: false })
}
fs.mkdirSync(args.out, { recursive: true })
const report = {}
for (const [name, body] of Object.entries(bodies)) {
  report[name] = { params: dryParse(body), bytes: Buffer.byteLength(body) }
  fs.writeFileSync(path.join(args.out, name + '.cdp.txt'), body)
}
const order = [
  'session new gpu=' + verbGpu + ' keep_alive',
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
const abortPolicy = [
  'grab.mjs prints ABORT: blockedInput=<n> when any probe in the saved artifact reported blocked>0',
  'on ABORT re-run <arm>-boot and discard that arm\'s artifacts; never run <arm>-capture through contaminated input',
  'analyze.mjs prints INPUT CONTAMINATED with the first arm and probe that saw it, and fails the no-input gate'
]
fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify({ head, bodySet, verb_gpu: verbGpu, gpuVocabulary: GPU_TOKENS, pose, minVeg, host, extras, built: new Date(stamp).toISOString(), order, abortPolicy, bodies: report }, null, 1))
console.log(JSON.stringify({ out: args.out, head, bodies: report }, null, 1))
