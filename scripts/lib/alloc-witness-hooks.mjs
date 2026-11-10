import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installSpecifierHooks } from './install-specifier-hooks.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const THREE_MODULE = join(ROOT, 'node_modules/three/build/three.module.js')

let scratch = null
function scratchDir() {
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), 'alloc-witness-'))
    process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
  }
  return scratch
}

const COUNTED = ['Vector2', 'Vector3', 'Quaternion']

function countingThreeSource() {
  const url = pathToFileURL(THREE_MODULE).href
  const lines = [
    `import * as T from '${url}'`,
    `export * from '${url}'`,
    `const counts = globalThis.__allocCounts ??= { constructed: {}, cloned: {} }`,
    ...COUNTED.map(n => `counts.constructed.${n} = 0; counts.cloned.${n} = 0`),
  ]
  for (const n of COUNTED) {
    lines.push(`export class ${n} extends T.${n} { constructor(...a) { super(...a); counts.constructed.${n}++ } }`)
    lines.push(`{ const orig = T.${n}.prototype.clone; T.${n}.prototype.clone = function () { counts.cloned.${n}++; return orig.call(this) } }`)
  }
  return lines.join('\n') + '\n'
}

function stubSource(exports) {
  return exports.join('\n') + '\n'
}

const DESIGN_STUB = stubSource([
  `export const components = { usePointerDrag(el, opts) { globalThis.__ptrDrag = opts; return { destroy() {} } } }`,
  `export const h = () => null`,
  `export const applyDiff = () => {}`,
])
const EDIT_PANEL_STUB = stubSource([`export const showToast = () => {}`])

export async function installAllocHooks({ countAllocations = false } = {}) {
  await installSpecifierHooks()
  const files = {}
  const write = (name, text) => {
    if (!files[name]) {
      files[name] = join(scratchDir(), name)
      writeFileSync(files[name], text)
    }
    return pathToFileURL(files[name]).href
  }
  const { registerHooks } = await import('node:module')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (countAllocations && specifier === 'three') {
        return { url: write('three.counting.mjs', countingThreeSource()), shortCircuit: true }
      }
      if (specifier === 'anentrypoint-design') {
        return { url: write('design.stub.mjs', DESIGN_STUB), shortCircuit: true }
      }
      if (specifier.endsWith('EditPanelDOM.js')) {
        return { url: write('EditPanelDOM.stub.mjs', EDIT_PANEL_STUB), shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

export function gitShow(rev, rel) {
  return execFileSync('git', ['show', `${rev}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

export function materializeBase(rev, relFiles) {
  const dir = join(scratchDir(), `base-${rev.slice(0, 7)}`)
  const paths = {}
  for (const rel of relFiles) paths[rel] = join(dir, rel)
  for (const rel of relFiles) {
    const source = gitShow(rev, rel)
    const rewritten = source.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g, (match, pre, quote, spec) => {
      const target = posix.normalize(posix.join(posix.dirname(rel), spec))
      const abs = relFiles.includes(target) ? paths[target] : join(ROOT, target)
      return `${pre}${quote}${pathToFileURL(abs).href}${quote}`
    })
    mkdirSync(dirname(paths[rel]), { recursive: true })
    writeFileSync(paths[rel], rewritten)
  }
  return Object.fromEntries(Object.entries(paths).map(([rel, p]) => [rel, pathToFileURL(p).href]))
}

export function treeUrl(rel) {
  return pathToFileURL(join(ROOT, rel)).href
}

export const BASE_REV = '48541f5'
