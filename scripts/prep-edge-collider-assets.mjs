#!/usr/bin/env node
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { detectDraco, stripDraco } from './glb-processor.js'

function log(msg) { console.log(`[prep-edge-collider-assets] ${msg}`) }

async function walk(dir, check, hits, errors, scanned) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { errors.push(`could not read directory ${dir}: ${e.code || e.message}`); return }
  for (const e of entries) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) { await walk(fp, check, hits, errors, scanned); continue }
    if (!e.isFile() || !e.name.endsWith('.glb')) continue
    scanned.push(fp)
    await prepFile(fp, check, hits, errors)
  }
}

async function prepFile(fp, check, hits, errors) {
  let buf
  try { buf = readFileSync(fp) } catch (e) { errors.push(`could not read ${fp}: ${e.code || e.message}`); return }
  if (!detectDraco(buf)) return
  hits.push(fp)
  if (check) { log(`DRACO-COMPRESSED (would strip): ${fp}`); return }
  const t0 = Date.now()
  const stripped = await stripDraco(buf)
  writeFileSync(fp, stripped)
  const savedKB = (buf.length - stripped.length) / 1024
  log(`${basename(fp)}: ${(buf.length/1024).toFixed(0)}KB -> ${(stripped.length/1024).toFixed(0)}KB (${savedKB > 0 ? '-' : '+'}${Math.abs(savedKB).toFixed(0)}KB) in ${Date.now()-t0}ms`)
}

async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const dirs = argv.filter(a => !a.startsWith('--'))
  const targets = dirs.length ? dirs : ['apps']
  const hits = []
  const errors = []
  const scanned = []
  log(`scanning [${targets.join(', ')}] for Draco-compressed GLB collider assets${check ? ' (--check, dry-run)' : ''}...`)
  for (const d of targets) await walk(d, check, hits, errors, scanned)
  if (errors.length) {
    for (const e of errors) log(`ERROR: ${e}`)
    log(`FAILED: ${errors.length} path(s) could not be read -- the scan is incomplete, not edge-safe.`)
    process.exit(1)
  }
  if (scanned.length === 0) {
    log(`FAILED: scanned 0 .glb files under [${targets.join(', ')}] -- an empty scan cannot show edge-safety.`)
    process.exit(1)
  }
  log(`scanned ${scanned.length} .glb file(s)`)
  if (hits.length === 0) { log('no Draco-compressed GLBs found -- edge-safe.'); return }
  if (check) {
    log(`FAILED: ${hits.length} Draco-compressed GLB(s) found -- not yet edge-safe. Run without --check to strip them.`)
    process.exit(1)
  }
  log(`done -- stripped Draco from ${hits.length} file(s).`)
}

main().catch(err => { console.error('[prep-edge-collider-assets] FAILED:', err); process.exit(1) })
