import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOW_LEVEL_COLLIDER = /\b(?:setStatic|setDynamic|setKinematic|addBoxCollider|addSphereCollider|addCapsuleCollider|addTrimeshCollider|addConvexCollider)\s*\(/

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length
}

function objectBlock(text, openIndex) {
  let depth = 0
  let quote = null
  let lineComment = false
  let blockComment = false
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i], next = text[i + 1]
    if (lineComment) { if (ch === '\n') lineComment = false; continue }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++ } continue }
    if (quote) { if (ch === '\\') { i++; continue } if (ch === quote) quote = null; continue }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(openIndex, i + 1)
    }
  }
  return ''
}

function blockAfter(text, pattern) {
  const m = pattern.exec(text)
  if (!m) return null
  const open = text.indexOf('{', m.index + m[0].length - 1)
  if (open < 0) return null
  return { block: objectBlock(text, open), index: m.index }
}

export function checkAppContractSource(text, filename = '<app>') {
  const violations = []
  const add = (code, line, message) => violations.push({ file: filename, code, line, message })

  const editorUpdate = text.search(/\bonEditorUpdate\b/)
  if (editorUpdate >= 0) add('app-contract-on-editor-update', lineAt(text, editorUpdate), 'onEditorUpdate is engine-owned; the editor applies position/rotation/scale/custom automatically')
  const collider = LOW_LEVEL_COLLIDER.exec(text)
  if (collider) add('app-contract-low-level-collider', lineAt(text, collider.index), `use ctx.physics.addColliderFromConfig instead of ${collider[0]}`)

  const defaultMatch = /export\s+default\s*\{/.exec(text)
  if (!defaultMatch) return violations
  const defaultOpen = text.indexOf('{', defaultMatch.index + defaultMatch[0].length - 1)
  const defaultBlock = objectBlock(text, defaultOpen)
  if (!defaultBlock) return violations

  const client = blockAfter(defaultBlock, /\bclient\s*:\s*\{/)
  if (client) {
    const render = blockAfter(client.block, /\brender\s*\([^)]*\)\s*\{/)
    if (render && !/\breturn\s*\{/.test(render.block)) {
      add('app-contract-render-no-object', lineAt(text, defaultMatch.index + defaultMatch[0].length + client.index), 'client.render must return a mesh-state object')
    }
  }

  const nested = /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/.exec(defaultBlock)
  if (nested) add('app-contract-nested-helper', lineAt(text, defaultMatch.index + defaultMatch[0].length + nested.index), 'declare helper functions at module top level, outside export default')

  const teardown = blockAfter(defaultBlock, /\bteardown\s*\([^)]*\)\s*\{/)
  if (teardown && /ctx\.world\.spawn\s*\(/.test(text) && /ctx\.world\.destroy\s*\(/.test(teardown.block)) {
    add('app-contract-manual-child-teardown', lineAt(text, defaultMatch.index + defaultMatch[0].length + teardown.index), 'use ctx.world.spawnChild instead of spawn plus manual teardown destroys')
  }
  return violations
}

export function appContractFiles(root = 'apps') {
  const out = []
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      if (name === '_lib' || name === '_fixtures' || name === 'world' || name === 'node_modules') continue
      if (/^editor-/.test(name) || name === 'example-progression') continue
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.js') && readFileSync(path, 'utf8').includes('export default')) out.push(path)
    }
  }
  walk(root)
  return out.sort()
}
