#!/usr/bin/env node
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { detectDraco, stripDraco } from './glb-processor.js'

function log(msg) { console.log(`[prep-edge-collider-assets] ${msg}`) }

async function walk(dir, check, hits) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const fp = join(dir, e.name)
    if (e.isDirectory()) { await walk(fp, check, hits); continue }
    if (!e.isFile() || !e.name.endsWith('.glb')) continue
    await prepFile(fp, check, hits)
  }
}

async function prepFile(fp, check, hits) {
  let buf
  try { buf = readFileSync(fp) } catch { log(`WARNING: could not read ${fp}, skipped`); return }
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
  log(`scanning [${targets.join(', ')}] for Draco-compressed GLB collider assets${check ? ' (--check, dry-run)' : ''}...`)
  for (const d of targets) await walk(d, check, hits)
  if (hits.length === 0) { log('no Draco-compressed GLBs found -- edge-safe.'); return }
  if (check) {
    log(`FAILED: ${hits.length} Draco-compressed GLB(s) found -- not yet edge-safe. Run without --check to strip them.`)
    process.exit(1)
  }
  log(`done -- stripped Draco from ${hits.length} file(s).`)
}

main().catch(err => { console.error('[prep-edge-collider-assets] FAILED:', err); process.exit(1) })
