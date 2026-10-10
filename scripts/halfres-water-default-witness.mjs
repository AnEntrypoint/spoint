import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const KNOB = 'halfResWater'
const GLOBAL_NAME = '__' + KNOB
const GLOBAL_REFERENCE = `\\bwindow\\s*(?:\\.\\s*${GLOBAL_NAME}\\b|\\[\\s*['"]${GLOBAL_NAME}['"]\\s*\\])`
const READER_PATTERN = new RegExp(GLOBAL_REFERENCE)
const WRITER_PATTERN = new RegExp(GLOBAL_REFERENCE + '\\s*=(?!=)')
const SOURCE_ROOTS = ['client', 'packages', 'src', 'apps', 'scripts', 'edge']
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.gm', '.git', 'dist', 'build', 'vendor'])
const SOURCE_FILE = /\.(m?js|cjs|ts|tsx|jsx)$/

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registryFile = join(root, 'client', 'core', 'RenderControls.js')
const presetsFile = join(root, 'client', 'core', 'QualityPresets.js')

const disagreements = []

function disagree(message) {
  disagreements.push(message)
  console.log('DISAGREE ' + message)
}

function displayPath(file) {
  return relative(root, file).split(sep).join('/')
}

function listSourceFiles(directory, found) {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) listSourceFiles(path, found)
    else if (SOURCE_FILE.test(entry)) found.push(path)
  }
  return found
}

function findReaders() {
  const readers = []
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = join(root, sourceRoot)
    if (!existsSync(absoluteRoot)) continue
    for (const file of listSourceFiles(absoluteRoot, [])) {
      readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
        if (READER_PATTERN.test(text) && !WRITER_PATTERN.test(text)) readers.push({ file, line: index + 1, text })
      })
    }
  }
  return readers
}

function matchingParenthesis(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function readerGuard(text) {
  const reference = text.search(READER_PATTERN)
  let outermost = -1
  let outermostClose = -1
  for (let open = 0; open < reference; open++) {
    if (text[open] !== '(') continue
    const close = matchingParenthesis(text, open)
    if (close > reference && (outermost < 0 || open < outermost)) {
      outermost = open
      outermostClose = close
    }
  }
  return outermost < 0 ? null : text.slice(outermost, outermostClose + 1)
}

function probesFor(registryDefault) {
  return [
    { label: 'unset without window', globalWindow: undefined, expected: registryDefault },
    { label: 'unset with window', globalWindow: {}, expected: registryDefault },
    { label: 'explicit true', globalWindow: { [GLOBAL_NAME]: true }, expected: true },
    { label: 'explicit false', globalWindow: { [GLOBAL_NAME]: false }, expected: false },
  ]
}

function checkReaders(registryDefault) {
  const readers = findReaders()
  if (readers.length === 0) disagree(`no reader of window.${GLOBAL_NAME} under ${SOURCE_ROOTS.join(', ')}`)
  for (const reader of readers) {
    const where = `${displayPath(reader.file)}:${reader.line}`
    const guard = readerGuard(reader.text)
    if (guard === null) {
      disagree(`${where} reader guard could not be isolated`)
      continue
    }
    let evaluate
    try {
      evaluate = new Function('window', `return ${guard};`)
    } catch (error) {
      disagree(`${where} reader guard does not compile: ${error.message}`)
      continue
    }
    for (const probe of probesFor(registryDefault)) {
      let actual
      try {
        actual = Boolean(evaluate(probe.globalWindow))
      } catch (error) {
        disagree(`${where} ${probe.label}: reader threw ${error.message}`)
        continue
      }
      if (actual === probe.expected) console.log(`agree ${where} ${probe.label}: ${actual}`)
      else disagree(`${where} ${probe.label}: reader gives ${actual}, registry gives ${probe.expected}`)
    }
  }
  return readers.length
}

async function main() {
  const registry = await import(pathToFileURL(registryFile).href)
  const entry = registry.RenderControls.controls.find((control) => control.key === KNOB)
  if (!entry) disagree(`registry declares no ${KNOB} knob`)
  const registryDefault = entry ? entry.default : undefined
  if (typeof registryDefault !== 'boolean') disagree(`registry default of ${KNOB} is ${JSON.stringify(registryDefault)}, not a boolean`)
  else console.log(`registry default ${KNOB} = ${registryDefault}`)
  const getWithoutWindow = registry.RenderControls.get(KNOB)
  if (getWithoutWindow !== registryDefault) disagree(`RenderControls.get(${KNOB}) without window gives ${JSON.stringify(getWithoutWindow)}, not the declared default`)

  const readerCount = checkReaders(registryDefault)
  console.log(`readers checked: ${readerCount}`)

  const presets = await import(pathToFileURL(presetsFile).href)
  const presetEntries = Object.entries(presets.QualityPresets.presets)
  if (presetEntries.length === 0) disagree('QualityPresets exports no presets')
  for (const [name, preset] of presetEntries) {
    if (typeof preset[KNOB] === 'boolean') console.log(`agree preset ${name} sets ${KNOB} = ${preset[KNOB]} explicitly`)
    else disagree(`preset ${name} does not set ${KNOB} explicitly`)
  }

  if (disagreements.length === 0) {
    console.log('RESULT: PASS')
    process.exitCode = 0
  } else {
    console.log(`RESULT: FAIL with ${disagreements.length} disagreement(s)`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.log(`RESULT: FAIL ${error.message}`)
  process.exitCode = 1
})
