#!/usr/bin/env node
// Witness for the leaf/bark texture budget boundary: client/core/TreeTextureBudget.js.
// Two claims are pinned here.
//   1. The budget is a TARGET EDGE IN PIXELS resolved at ONE boundary, and a value
//      that is supplied but cannot be honoured is REFUSED with a code instead of
//      silently becoming the default. The bare-flag trap is the sharpest case: a
//      value that parses to NaN must refuse, because Number() on it yields NaN and
//      a `Number.isFinite(x) ? x : DEFAULT` guard would quietly hand back 1024.
//   2. 1024 -> 512 is a real halving, not a no-op: one halving step, and the mip
//      chain of four leaf textures drops by a counted number of bytes.
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET = process.env.TREE_TEXTURE_BUDGET_MODULE
  ? resolve(process.env.TREE_TEXTURE_BUDGET_MODULE)
  : resolve(REPO, 'client/core/TreeTextureBudget.js')
const {
  resolveTreeTextureBudget, parseTreeTextureMaxPx, halvingsFor,
  mipChainBytes, decodedRgbaBytes,
  TREE_TEXTURE_SOURCE_PX, LEAF_TEXTURE_MAX_PX_DEFAULT, BARK_TEXTURE_MAX_PX_DEFAULT,
} = await import(pathToFileURL(BUDGET).href)

let failures = 0
function expect(claim, got, want) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${claim}`)
  if (!ok) console.log(`     want ${want}\n     got  ${got}`)
}
function expectRefusal(claim, reasonCode, fn) {
  let code = 'no-throw'
  try { fn() } catch (e) { code = e && e.reasonCode ? e.reasonCode : 'threw:' + (e && e.message) }
  const ok = code === reasonCode
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${claim}`)
  if (!ok) console.log(`     want ${reasonCode}\n     got  ${code}`)
}

// --- the source fact the whole budget is priced against -------------------------
expect('ez-tree ships leaf maps at 1024 px an edge', TREE_TEXTURE_SOURCE_PX, 1024)
expect('the leaf default is a halving of the source, not the source', LEAF_TEXTURE_MAX_PX_DEFAULT, TREE_TEXTURE_SOURCE_PX >> 1)

// --- counted units: decoded RGBA plus the mip chain -----------------------------
expect('one 1024x1024 RGBA mip chain is 5592404 B', mipChainBytes(1024, 1024), 5592404)
expect('one 512x512 RGBA mip chain is 1398100 B', mipChainBytes(512, 512), 1398100)
expect('four leaf maps at 1024 are 22369616 B of mip chain', 4 * mipChainBytes(1024, 1024), 22369616)
expect('four leaf maps at 512 are 5592400 B of mip chain', 4 * mipChainBytes(512, 512), 5592400)
expect('halving the four leaf maps frees 16777216 B of mip chain', 4 * (mipChainBytes(1024, 1024) - mipChainBytes(512, 512)), 16777216)
expect('sixteen bark maps at 1024 are 89478464 B of mip chain', 16 * mipChainBytes(1024, 1024), 89478464)
expect('sixteen bark maps at 64 are 349504 B of mip chain', 16 * mipChainBytes(64, 64), 349504)
expect('a decoded 1024x1024 RGBA level is 4194304 B', decodedRgbaBytes(1024, 1024), 4194304)

// --- the halving is real, and it is derived from the actual width ---------------
expect('1024 with a 512 budget is exactly one halving', halvingsFor(1024, 512), 1)
expect('1024 with a 64 budget is exactly four halvings', halvingsFor(1024, 64), 4)
expect('1024 with a 1024 budget is zero halvings (budget already met)', halvingsFor(1024, 1024), 0)
expect('512 with a 512 budget is zero halvings (idempotent, not re-halved)', halvingsFor(512, 512), 0)
expect('256 with a 64 budget is two halvings', halvingsFor(256, 64), 2)

// --- the boundary: absent falls through, supplied-and-invalid refuses -----------
const d = resolveTreeTextureBudget({})
expect('default leaf budget is 512', d.leafMaxPx, 512)
expect('default bark budget is 64', d.barkMaxPx, 64)
expect('bark default matches BARK_TEXTURE_MAX_PX_DEFAULT', d.barkMaxPx, BARK_TEXTURE_MAX_PX_DEFAULT)
expect('an absent value parses to null, not to the default', parseTreeTextureMaxPx(undefined, 'x'), null)
expectRefusal('an empty value refuses instead of falling through to the default', 'empty-value', () => parseTreeTextureMaxPx('', 'x'))
expect('a supplied power of two in range parses', parseTreeTextureMaxPx('256', 'x'), 256)
expect('a supplied number parses', parseTreeTextureMaxPx(512, 'x'), 512)

expectRefusal('a value of "true" refuses rather than parsing to NaN and becoming the default', 'not-a-number', () => resolveTreeTextureBudget({ search: '?leaftex=true' }))
expectRefusal('a supplied but empty value refuses rather than falling through', 'empty-value', () => resolveTreeTextureBudget({ search: '?leaftex=' }))
expect('a key with no "=" at all is absent, so the default stands', resolveTreeTextureBudget({ search: '?leaftex' }).leafMaxPx, 512)
expectRefusal('a non-numeric string refuses', 'not-a-number', () => parseTreeTextureMaxPx('abc', '?leaftex='))
expectRefusal('NaN refuses', 'not-a-number', () => parseTreeTextureMaxPx(NaN, '?leaftex='))
expectRefusal('Infinity refuses', 'not-a-number', () => parseTreeTextureMaxPx(Infinity, '?leaftex='))
expectRefusal('a non-power-of-two refuses', 'not-a-power-of-two', () => parseTreeTextureMaxPx('700', '?leaftex='))
expectRefusal('3 refuses', 'not-a-power-of-two', () => parseTreeTextureMaxPx(3, '?leaftex='))
expectRefusal('0 refuses', 'not-a-power-of-two', () => parseTreeTextureMaxPx(0, '?leaftex='))
expectRefusal('above the source size refuses', 'above-maximum', () => parseTreeTextureMaxPx(2048, '?leaftex='))
expectRefusal('below the floor refuses', 'below-minimum', () => parseTreeTextureMaxPx(32, '?leaftex='))
expectRefusal('a fractional size refuses', 'not-an-integer', () => parseTreeTextureMaxPx('512.5', '?leaftex='))
expectRefusal('an object refuses', 'not-a-number', () => parseTreeTextureMaxPx({}, '?leaftex='))
expectRefusal('a non-string search refuses', 'search-not-a-string', () => resolveTreeTextureBudget({ search: 5 }))
expectRefusal('a non-object spec refuses', 'spec-not-an-object', () => resolveTreeTextureBudget('nope'))
expectRefusal('a texture width of 0 refuses rather than silently skipping', 'not-a-texture-width', () => halvingsFor(0, 512))

// --- precedence: URL over cfg over default -------------------------------------
expect('a URL value wins over cfg', resolveTreeTextureBudget({ search: '?leaftex=256', cfg: { leafTextureMaxPx: 128 } }).leafMaxPx, 256)
expect('cfg is used when the URL is silent', resolveTreeTextureBudget({ search: '?other=1', cfg: { leafTextureMaxPx: 128 } }).leafMaxPx, 128)
expect('bark is budgeted independently of leaf', resolveTreeTextureBudget({ search: '?leaftex=256&barktex=128' }).barkMaxPx, 128)
expect('a leaf-only URL leaves bark on its default', resolveTreeTextureBudget({ search: '?leaftex=256' }).barkMaxPx, BARK_TEXTURE_MAX_PX_DEFAULT)

console.log(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} claim(s))`)
process.exit(failures === 0 ? 0 : 1)
