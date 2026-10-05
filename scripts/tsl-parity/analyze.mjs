import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { decodePng, regionMasks, regionMean, regionMeanAbs } from './png.mjs'

const K = 3, FLOOR_MIN = 1.0, SKY_GATE = 0.2
const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=')] }))
if (!args.dir || !args.gpu) {
  console.error('usage: node scripts/tsl-parity/analyze.mjs --gpu=<label> --dir=<dir with tsl-boot.json tsl-capture.json legacy-boot.json legacy-capture.json [tsl-settle.json legacy-settle.json tsl-left-edge.json legacy-left-edge.json tsl-geomorph-off-boot.json tsl-geomorph-off-capture.json]>')
  process.exit(2)
}
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')

function readText(file) {
  const t = fs.readFileSync(file, 'utf8')
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
}

function load(name) {
  const f = path.join(args.dir, name + '.json')
  if (!fs.existsSync(f)) return null
  const j = JSON.parse(readText(f))
  const d = j.data || j
  const r = d.result !== undefined ? d.result : d
  const results = Array.isArray(r) ? r : (r.results || [])
  const events = Array.isArray(r) ? [] : (r.events || [])
  const values = [], frames = {}
  let lastLabel = null
  for (const item of results) {
    if (item && item.result && typeof item.result.value === 'string') {
      let v = null
      try { v = JSON.parse(item.result.value) } catch { v = null }
      if (v) { values.push(v); lastLabel = v.frame || null; if (v.frame) frames[v.frame] = { sig: v } }
    } else if (item && item.data && lastLabel) {
      frames[lastLabel].img = decodePng(item.data)
      lastLabel = null
    }
  }
  return { values, frames, events, ok: j.ok !== false && (j.data ? j.data.ok !== false : true) }
}

const pick = (...names) => names.map(load).find(Boolean) || null
const tslBoot = load('tsl-boot'), legBoot = load('legacy-boot')
const tslSettle = pick('tsl-settle', 'tsl-boot'), legSettle = pick('legacy-settle', 'legacy-boot')
const tslCap = load('tsl-capture'), legCap = load('legacy-capture')
if (!tslBoot || !legBoot || !tslCap || !legCap) { console.error('missing one of tsl-boot, legacy-boot, tsl-capture, legacy-capture in ' + args.dir); process.exit(2) }

const headNow = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim()

function manifestHead(file) {
  if (!fs.existsSync(file)) return null
  try {
    const m = JSON.parse(readText(file))
    return typeof m.head === 'string' && m.head ? { sha: m.head, source: 'manifest.json' } : null
  } catch { return null }
}

function grabHead(dir) {
  const f = path.join(dir, 'head.json')
  if (!fs.existsSync(f)) return null
  try {
    const h = JSON.parse(readText(f))
    const shas = [].concat(h.heads || h.head || []).filter(s => typeof s === 'string' && s)
    return shas.length ? { sha: shas[0], source: 'head.json' } : null
  } catch { return null }
}

function probeHead(boot) {
  for (const v of (boot && boot.values) || []) if (v && typeof v.head === 'string' && v.head) return { sha: v.head, source: 'boot probe' }
  return null
}

const headSources = [grabHead(args.dir), manifestHead(args.manifest || path.join(args.dir, 'manifest.json')), probeHead(tslBoot), probeHead(legBoot)].filter(Boolean)
const headShas = [...new Set(headSources.map(s => s.sha))]
const captureHead = headSources[0] || null
const headMismatch = captureHead ? captureHead.sha !== headNow : null

const settleOf = s => s && s.values.filter(v => v.settle !== undefined).slice(-1)[0]
const gates = []
const gate = (name, pass, detail) => gates.push({ name, pass: !!pass, detail })

const ts = settleOf(tslSettle), ls = settleOf(legSettle)
gate('vegetation settled on both renderers', ts && ts.settle && ls && ls.settle, { tsl: ts && ts.veg, legacy: ls && ls.veg })
const allSigs = cap => Object.values(cap.frames).map(f => f.sig)
const vegs = new Set([...allSigs(tslCap), ...allSigs(legCap)].map(s => s.veg))
gate('vegetation equal and constant across every frame of both renderers', vegs.size === 1, { counts: [...vegs] })

const camKey = s => JSON.stringify(s.cam)
const camsOk = ['sky', 'skyFull', 'ground', 'grey', 'greyRelief1'].every(base => {
  const keys = new Set([tslCap, legCap].flatMap(c => ['-a', '-b'].map(sfx => c.frames[base + sfx]).filter(Boolean).map(f => camKey(f.sig))))
  return keys.size <= 1
})
gate('camera pose identical per pose across frames and renderers', camsOk, null)
const ammo = new Set([...allSigs(tslCap), ...allSigs(legCap)].map(s => String(s.ammo)))
gate('ammo signature identical across all frames', ammo.size === 1, { ammo: [...ammo] })
const probesOf = src => src.values.filter(v => v.probe).map(p => ({ probe: p.probe, href: p.href, blocked: Number(p.blocked) || 0 }))
const allProbes = [...probesOf(tslBoot), ...probesOf(legBoot), ...probesOf(tslCap), ...probesOf(legCap)]
const blocked = Math.max(0, ...[...allSigs(tslCap), ...allSigs(legCap)].map(s => s.blocked || 0), ...allProbes.map(p => p.blocked))
gate('no input reached the page', blocked === 0, { blocked, probes: allProbes, tslInputLog: ts && ts.inputLog, legacyInputLog: ls && ls.inputLog })

const hashRows = []
for (const ev of [...tslBoot.events, ...legBoot.events].filter(e => e.event === 'Debugger.scriptParsed')) {
  const u = ev.params.url, m = u.match(/\/node_modules\/mapspinner\/(.+?)(\?|$)/)
  if (!m) continue
  const disk = path.join(repo, 'packages', 'mapspinner', m[1])
  const sha = fs.existsSync(disk) ? crypto.createHash('sha256').update(fs.readFileSync(disk)).digest('hex') : null
  hashRows.push({ file: m[1], executed: ev.params.hash, disk: sha, match: sha === ev.params.hash })
}
const uniqueHashes = Object.values(Object.fromEntries(hashRows.map(r => [r.file + r.executed, r])))
gate('executed mapspinner bytes equal disk', uniqueHashes.length > 0 && uniqueHashes.every(r => r.match), { checked: uniqueHashes.length, mismatched: uniqueHashes.filter(r => !r.match).map(r => r.file) })
const docStamp = s => { const m = String((s && s.href) || '').match(/[?&]v=([a-z]\d+)/); return m ? m[1] : null }
const exceptionsOf = (boot, settle) => {
  const stamp = docStamp(settle)
  const list = boot.events.filter(e => e.event === 'Runtime.exceptionThrown')
  const url = e => String(((e.params || {}).exceptionDetails || {}).url || '')
  const mine = stamp ? list.filter(e => { const u = url(e); return u === '' || u.includes('v=' + stamp) }) : list
  const foreign = list.filter(e => !mine.includes(e))
  return { count: mine.length, mine: mine.map(e => ({ ...((e.params || {}).exceptionDetails || {}), url: url(e) })), foreign: foreign.map(e => ({ ...((e.params || {}).exceptionDetails || {}), url: url(e) })), docStamp: stamp }
}
const tslEx = exceptionsOf(tslBoot, ts), legEx = exceptionsOf(legBoot, ls)
const exceptions = tslEx.count + legEx.count
const w = s => (s && s.witness) || {}
gate('no exceptions, page errors or console errors during boot', exceptions === 0 && !w(ts).pageErrors && !w(ls).pageErrors && !w(ts).consoleErrors && !w(ls).consoleErrors, {
  exceptions,
  tslDoc: tslEx.docStamp,
  legacyDoc: legEx.docStamp,
  tslExceptions: tslEx.mine,
  legacyExceptions: legEx.mine,
  foreignExceptionsFromOtherNavigations: [...tslEx.foreign, ...legEx.foreign],
  tsl: w(ts).msgs,
  legacy: w(ls).msgs
})

const fullIdx = img => Array.from({ length: img.w * img.h }, (_, i) => i)
function compare(base, maskRef, regionNames) {
  const ta = tslCap.frames[base + '-a'], tb = tslCap.frames[base + '-b'], la = legCap.frames[base + '-a'], lb = legCap.frames[base + '-b']
  if (!ta || !la || !ta.img || !la.img) return null
  const masks = maskRef ? regionMasks(maskRef).masks : { clip: fullIdx(ta.img) }
  const rows = {}
  for (const k of regionNames || Object.keys(masks)) {
    const idx = masks[k]
    if (!idx || idx.length < 200) { rows[k] = { n: idx ? idx.length : 0, skipped: true }; continue }
    const tm = regionMean(ta.img, idx), lm = regionMean(la.img, idx), mad = regionMeanAbs(ta.img, la.img, idx)
    const floor = Math.max(tb && tb.img ? regionMeanAbs(ta.img, tb.img, idx) : 0, lb && lb.img ? regionMeanAbs(la.img, lb.img, idx) : 0, FLOOR_MIN)
    rows[k] = { n: idx.length, tsl: tm, legacy: lm, delta: tm.map((v, c) => +(v - lm[c]).toFixed(2)), meanAbs: mad, floor: +floor.toFixed(3), ratio: +(mad / floor).toFixed(3), pass: mad <= K * floor }
  }
  return rows
}
const legSkyRef = legCap.frames['skyFull-a'] && legCap.frames['skyFull-a'].img
const legGroundRef = legCap.frames['ground-a'] && legCap.frames['ground-a'].img
const regions = ['sky', 'terrain', 'grass', 'water', 'leftLower', 'leftEdge', 'vegColumn']
const sets = {
  skyClip: compare('sky', null),
  skyPose: legSkyRef && compare('skyFull', legSkyRef, regions),
  ground: legGroundRef && compare('ground', legGroundRef, regions),
  grey: legGroundRef && compare('grey', legGroundRef, regions),
  greyRelief1: legGroundRef && compare('greyRelief1', legGroundRef, regions)
}
const skyMad = sets.skyPose && sets.skyPose.sky && sets.skyPose.sky.meanAbs
const groundSkyMad = sets.ground && sets.ground.sky && sets.ground.sky.meanAbs
gate('sky region TSL vs legacy within ' + SKY_GATE + ' (state settled)', skyMad != null && skyMad <= SKY_GATE && (groundSkyMad == null || groundSkyMad <= SKY_GATE), { skyPose: skyMad, groundPose: groundSkyMad })

const guardRows = []
for (const [arm, src] of [['tsl-boot', tslBoot], ['legacy-boot', legBoot], ['tsl-capture', tslCap], ['legacy-capture', legCap]]) {
  for (const v of (src && src.values) || []) {
    if (!v || typeof v !== 'object' || v.blocked === undefined) continue
    guardRows.push({ arm, at: v.probe || v.frame || null, blocked: Number(v.blocked) || 0, canvas: v.canvas || v.cv || null })
  }
}
const canvasSizes = [...new Set(guardRows.map(r => JSON.stringify(r.canvas)).filter(c => c !== 'null'))]
const firstBlocked = guardRows.find(r => r.blocked > 0) || null

const out = {
  gpu: args.gpu,
  head: headNow,
  captureHead: captureHead && captureHead.sha,
  captureHeadSource: captureHead && captureHead.source,
  captureHeadShas: headShas,
  headMismatch,
  criterion: { K, floorMin: FLOOR_MIN, skyGate: SKY_GATE },
  verdict: gates.every(g => g.pass) ? 'pair valid' : 'pair invalid',
  gates,
  settle: { tsl: ts, legacy: ls },
  executedHashes: uniqueHashes,
  inputGuard: { blocked, firstBlocked, canvasSizes, probes: guardRows },
  sets
}

const gm0 = load('tsl-geomorph-off-capture')
if (gm0 && legGroundRef) {
  const masks = regionMasks(legGroundRef).masks, r = {}
  for (const k of regions) {
    const idx = masks[k]; if (!idx || idx.length < 200) continue
    const g = f => gm0.frames[f] && gm0.frames[f].img, t = f => tslCap.frames[f] && tslCap.frames[f].img, l = f => legCap.frames[f].img
    const shift = (a, b) => regionMean(a, idx).map((v, c) => +(v - regionMean(b, idx)[c]).toFixed(2))
    r[k] = { gm0GreyVsLegacy: shift(g('gm0-grey-a'), l('grey-a')), gm0ReliefShift: shift(g('gm0-greyRelief1-a'), g('gm0-grey-a')), gm1ReliefShift: shift(t('greyRelief1-a'), t('grey-a')), gm0Veg: gm0.frames['gm0-grey-a'].sig.veg }
  }
  out.geomorphOff = r
}
const leT = load('tsl-left-edge'), leL = load('legacy-left-edge')
if (leT && legGroundRef) {
  const masks = regionMasks(legGroundRef).masks, r = {}
  for (const [label, f] of Object.entries(leT.frames)) {
    if (!f.img) continue
    const lf = leL && leL.frames[label] && leL.frames[label].img
    r[label] = Object.fromEntries(['leftEdge', 'leftLower', 'terrain'].map(k => [k, { tsl: regionMean(f.img, masks[k]), legacy: lf ? regionMean(lf, masks[k]) : null, delta: lf ? regionMean(f.img, masks[k]).map((v, c) => +(v - regionMean(lf, masks[k])[c]).toFixed(2)) : null }]))
  }
  const resp = (a, b, k) => leT.frames[a] && leT.frames[b] && leT.frames[a].img && leT.frames[b].img ? regionMean(leT.frames[a].img, masks[k]).map((v, c) => +(v - regionMean(leT.frames[b].img, masks[k])[c]).toFixed(2)) : null
  const within = (d, lim) => d && d.every(x => Math.abs(x) <= lim)
  out.leftEdgeScore = {
    texNrmK0: { leftLowerDelta: r['le-texNrmK0'] && r['le-texNrmK0'].leftLower.delta, closesWithin1p5: within(r['le-texNrmK0'] && r['le-texNrmK0'].leftLower.delta, 1.5), reliefResponseDefault: resp('le-greyRelief1', 'le-grey', 'leftLower'), reliefResponseTexNrmK0: resp('le-texNrmK0Relief1', 'le-texNrmK0', 'leftLower'), reliefResponseWithin0p5: within(resp('le-texNrmK0Relief1', 'le-texNrmK0', 'leftLower'), 0.5) },
    flatNormal: { leftLowerDelta: r['le-flatNormal'] && r['le-flatNormal'].leftLower.delta, closesWithin1p5: within(r['le-flatNormal'] && r['le-flatNormal'].leftLower.delta, 1.5) },
    both: { leftLowerDelta: r['le-texNrmK0FlatNormal'] && r['le-texNrmK0FlatNormal'].leftLower.delta, leftEdgeDelta: r['le-texNrmK0FlatNormal'] && r['le-texNrmK0FlatNormal'].leftEdge.delta },
    bothShadowOff: { leftLowerDelta: r['le-texNrmK0FlatNormalShadowOff'] && r['le-texNrmK0FlatNormalShadowOff'].leftLower.delta }
  }
  out.leftEdge = r
}

fs.writeFileSync(path.join(args.dir, 'analysis-' + args.gpu + '.json'), JSON.stringify(out, null, 1))
console.log(args.gpu + ' ' + out.verdict + ' (HEAD ' + out.head.slice(0, 8) + ')')
if (!captureHead) console.log('HEAD UNKNOWN: no capture-time sha in ' + args.dir + ' -- this verdict names only the analyze-time HEAD ' + headNow.slice(0, 8) + ' and may attribute these frames to bytes that never rendered')
else if (headShas.length > 1) console.log('HEAD DISAGREEMENT: capture-time sources disagree (' + headShas.map(s => s.slice(0, 8)).join(' vs ') + ') -- analyze-time HEAD ' + headNow.slice(0, 8))
else if (headMismatch) console.log('HEAD MISMATCH: captured at ' + captureHead.sha.slice(0, 8) + ' (' + captureHead.source + '), analyzed at ' + headNow.slice(0, 8) + ' -- these frames were rendered by ' + captureHead.sha.slice(0, 8) + ', not by HEAD')
else console.log('head ok: capture ' + captureHead.sha.slice(0, 8) + ' (' + captureHead.source + ') == analyze ' + headNow.slice(0, 8))
if (firstBlocked) console.log('INPUT CONTAMINATED: first blockedInput=' + firstBlocked.blocked + ' at ' + firstBlocked.arm + '/' + firstBlocked.at + ' -- re-navigate, do not capture through it')
for (const g of gates) console.log((g.pass ? 'PASS ' : 'FAIL ') + g.name + (g.detail ? ' ' + JSON.stringify(g.detail).slice(0, 160) : ''))
for (const [set, rows] of Object.entries(sets)) {
  if (!rows) { console.log(set + ': missing frames'); continue }
  for (const [k, v] of Object.entries(rows)) console.log([set, k, v.skipped ? 'skipped n=' + v.n : 'delta=' + v.delta.join(',') + ' meanAbs=' + v.meanAbs + ' floor=' + v.floor + ' ratio=' + v.ratio + ' ' + (v.pass ? 'PASS' : 'FAIL')].join(' '))
}
