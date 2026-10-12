#!/usr/bin/env node
// Per-decode allocation rate for the input codec: bytes per decode+quantize cycle and the call
// sites that own them, taken from V8's allocation sampler over N real cycles of a real module.
// Witness for PERF-hitch-perframe-allocation-r1. The browser arm (per-frame-allocation-browser-
// witness.mjs) names readRecord/readRecordInto as the largest attributable per-frame site, but its
// total moves with scene and streaming state; this arm measures that one site before/after with no
// GPU and no page, the same N cycles of the same protocol, the only variable being the code.
//
// --module=<path> loads the revision under test, so one command measures the committed code and the
// next measures the edited tree. Every decoded object is retained in a sink: a discarded result is
// scalar-replaced by the optimizer and then allocates nothing, measuring nothing.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Session } from 'node:inspector'
import { numericFlag, parseArgs, strArg } from './lib/witness-args.mjs'

const LABEL = 'per-decode-allocation'
const LF = String.fromCharCode(10)
const MIN_PLAUSIBLE_BYTES_PER_CYCLE = 32

const args = parseArgs(process.argv.slice(2))
const MODULE = strArg(args.module, null)
const ITERS = numericFlag(args, 'iters', 200000)
const WARMUP = numericFlag(args, 'warmup', 20000)
const INTERVAL = numericFlag(args, 'interval', 1024)
const OUT = strArg(args.out, null)
const BASELINE = strArg(args.baseline, null)

const checks = []
const OPS = {
  '==': (g, w) => Object.is(g, w),
  '<=': (g, w) => g <= w,
  '>=': (g, w) => g >= w,
  '>': (g, w) => g > w,
  '<': (g, w) => g < w,
}
function expect(label, got, op, want) {
  const pass = OPS[op](got, want) === true
  checks.push({ label, got, op, want, pass })
  return pass
}
function report(verdict, detail) {
  const failed = checks.filter(c => !c.pass)
  for (const c of failed) console.log(`[${LABEL}] FAILED ${c.label}: got ${JSON.stringify(c.got)} ${c.op} ${JSON.stringify(c.want)}`)
  console.log(`[${LABEL}] checks ${checks.length - failed.length}/${checks.length} passed`)
  if (verdict === 'FAIL') {
    console.log(`RESULT: FAIL label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
    process.exit(failed.length > 0 ? 1 : 1)
  }
  console.log(`RESULT: PASS label=${LABEL} -- ${String(detail).split(LF).join(' ')}`)
  process.exit(0)
}
const failDetail = (d) => report('FAIL', d)

function attribution(profile) {
  const head = profile && profile.head
  if (!head) return null
  const bySite = new Map()
  let total = 0
  let unattributed = 0
  const walk = (node, namedAncestor) => {
    const cf = node.callFrame || {}
    const self = Number.isFinite(node.selfSize) ? node.selfSize : 0
    if (self > 0) {
      total += self
      const named = cf.url ? cf : namedAncestor
      if (!named) {
        unattributed += self
        const key = `(unattributed) ${cf.functionName || '(native)'}`
        const prev = bySite.get(key)
        if (prev) prev.selfSize += self
        else bySite.set(key, { name: cf.functionName || '(native)', url: '', line: 0, selfSize: self })
      } else {
        const k = {
          name: cf && cf.functionName ? cf.functionName : '(anonymous)',
          url: cf && cf.url ? cf.url : '',
          line: cf && Number.isFinite(cf.lineNumber) ? cf.lineNumber + 1 : 0,
        }
        const key = `${k.name}@${k.url}:${k.line}`
        const prev = bySite.get(key)
        if (prev) prev.selfSize += self
        else bySite.set(key, { ...k, selfSize: self })
      }
    }
    const nextAncestor = cf.url ? cf : namedAncestor
    for (const child of node.children || []) walk(child, nextAncestor)
  }
  walk(head, null)
  return { total, unattributed, sites: [...bySite.values()].sort((a, b) => b.selfSize - a.selfSize) }
}

const session = new Session()
const post = (method, params) => new Promise((res, rej) => {
  session.post(method, params, (err, r) => (err ? rej(new Error(`${method}: ${err.message}`)) : res(r)))
})

async function arm() {
  if (!MODULE) failDetail('--module=<path> is required: point it at the InputCodec revision under test')
  const codec = await import(pathToFileURL(MODULE).href)
  const schema = codec.createInputSchema()
  const sent = { forward: true, jump: true, yaw: 1.2, pitch: -0.3, expr: 4, analogForward: 0.5, analogRight: -0.25 }
  const packet = codec.encodeInputPacket(schema, [{ sequence: 7, data: sent }], 3)

  const decoded = codec.decodeInputPacket(schema, packet)
  const quantized = codec.quantizeInput(schema, sent)
  expect('the packet under test is accepted', decoded.accepted === true, '==', true)
  expect('the packet under test decodes one record', decoded.entries.length, '==', 1)
  expect('the decoded record carries the sequence it was sent with', decoded.entries[0].sequence, '==', 7)
  expect('the decoded record carries the epoch it was sent with', decoded.chartEpoch, '==', 3)
  expect('the decoded data equals the quantization of the sent input', isDeepStrictEqual(decoded.entries[0].data, quantized), '==', true)
  const again = codec.decodeInputPacket(schema, packet).entries[0].data
  const third = codec.decodeInputPacket(schema, packet).entries[0].data
  expect('two decodes of the same packet return two distinct data objects', Object.is(decoded.entries[0].data, again), '==', false)
  expect('a later decode does not mutate the data an earlier decode returned',
    isDeepStrictEqual(decoded.entries[0].data, again) && isDeepStrictEqual(again, third), '==', true)

  const cycle = (sink, at) => {
    const d = codec.decodeInputPacket(schema, packet)
    sink[at] = d.entries
    sink[at + 1] = codec.quantizeInput(schema, sent)
  }
  const warmSink = new Array(WARMUP * 2)
  for (let i = 0; i < WARMUP; i++) cycle(warmSink, i * 2)

  const sink = new Array(ITERS * 2)
  session.connect()
  await post('HeapProfiler.enable')
  await post('HeapProfiler.startSampling', { samplingInterval: INTERVAL })
  const t0 = Date.now()
  for (let i = 0; i < ITERS; i++) cycle(sink, i * 2)
  const loopMs = Date.now() - t0
  const sampled = await post('HeapProfiler.stopSampling')
  await post('HeapProfiler.disable')
  session.disconnect()

  const att = attribution(sampled && sampled.profile)
  if (!att) failDetail('the sampling profiler returned no profile')
  const bytesPerCycle = att.total / ITERS
  const rows = att.sites.slice(0, 10).map(s => ({
    site: `${s.name} ${s.url ? String(s.url).split('/').slice(-1)[0] : '(no js frame)'}:${s.line}`,
    url: s.url,
    line: s.line,
    bytes: Math.round(s.selfSize),
    bytesPerCycle: +(s.selfSize / ITERS).toFixed(2),
    pct: +((s.selfSize / att.total) * 100).toFixed(2),
  }))
  const codecRows = rows.filter(r => r.url && String(r.url).includes('InputCodec'))
  const site = codecRows.find(r => r.site.startsWith('readRecord')) || codecRows[0] || null

  console.log(`[${LABEL}] module=${MODULE}`)
  console.log(`[${LABEL}] ${ITERS} decode+quantize cycles in ${loopMs}ms at sampling interval ${INTERVAL}; allocated=${Math.round(att.total)}B; unattributed=${Math.round(att.unattributed)}B`)
  for (const r of rows) console.log(`[${LABEL}] site ${r.pct}% ${r.bytes}B ${r.bytesPerCycle}B/cycle ${r.site}`)
  console.log(`[${LABEL}] bytesPerCycle=${bytesPerCycle.toFixed(2)} codecSite=${site ? site.site : null} codecBytesPerCycle=${site ? site.bytesPerCycle : null}`)

  expect('the run measured enough cycles to resolve a per-cycle rate', ITERS, '>=', 100000)
  expect('the profile attributed bytes to a call tree', att.sites.length, '>', 1)
  expect('the retained sink holds one decoded entry per cycle', sink.length, '==', ITERS * 2)
  expect('the sampler saw the cycles allocate, so the loop was not optimized away', bytesPerCycle, '>', MIN_PLAUSIBLE_BYTES_PER_CYCLE)
  expect('the codec site was named by the sampler, not only native leaves', site !== null, '==', true)
  if (site) expect('the codec site owns a share worth removing', site.pct, '>=', 3)

  let baseline = null
  if (BASELINE) {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
    expect(`bytes/cycle improved on the baseline (${baseline.bytesPerCycle})`, bytesPerCycle, '<', baseline.bytesPerCycle)
    if (site && Number.isFinite(baseline.codecBytesPerCycle)) {
      expect(`the codec site's bytes/cycle improved on the baseline (${baseline.codecBytesPerCycle})`, site.bytesPerCycle, '<', baseline.codecBytesPerCycle)
    }
  }

  const summary = {
    module: MODULE, iters: ITERS, warmup: WARMUP, samplingInterval: INTERVAL, loopMs,
    bytesPerCycle: +bytesPerCycle.toFixed(2),
    allocatedBytes: Math.round(att.total),
    unattributedBytes: Math.round(att.unattributed),
    codecSite: site ? site.site : null,
    codecBytesPerCycle: site ? site.bytesPerCycle : null,
    codecSitePct: site ? site.pct : null,
    topSites: rows,
  }
  if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2) + LF)

  if (checks.some(c => !c.pass)) failDetail(`${checks.filter(c => !c.pass).length} check(s) failed`)
  report('PASS', `${bytesPerCycle.toFixed(2)} B/cycle over ${ITERS} decode+quantize cycles of ${MODULE}, codec site ${site ? site.site : 'unnamed'} at ${site ? site.bytesPerCycle : 'n/a'} B/cycle (${site ? site.pct : 'n/a'}%)${baseline ? `; baseline ${baseline.bytesPerCycle} B/cycle, codec site ${baseline.codecBytesPerCycle} B/cycle` : ''}`)
}

arm().catch(e => {
  try { session.disconnect() } catch (_) {}
  failDetail(e && e.stack ? e.stack : String(e))
})
