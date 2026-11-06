import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SWAP_DEFINITION = /^const _hotSwap\w+ = \(next\) => \{/m
const SELF_ACCEPT = /globalThis\.__spointHmr\?\.acceptSelf\?\.\(import\.meta\.url, _hotSwap\w+\)/

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.m?js$/.test(name)) out.push(path)
  }
  return out
}

const swapModules = sourceFiles('src').filter(path => SWAP_DEFINITION.test(readFileSync(path, 'utf8')))
assert.ok(swapModules.length >= 80, `the hot-swap scan must be non-vacuous, got ${swapModules.length}`)
const unaccepted = swapModules.filter(path => !SELF_ACCEPT.test(readFileSync(path, 'utf8')))
assert.deepEqual(unaccepted, [], 'every module that defines a hot-swap function must accept its own edits with acceptSelf')

console.log(`RESULT: PASS ${swapModules.length} src module(s) define a hot-swap function and every one calls globalThis.__spointHmr.acceptSelf(import.meta.url, swap)`)
