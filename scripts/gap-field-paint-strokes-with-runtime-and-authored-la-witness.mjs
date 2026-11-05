import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createFieldLayers } = await import(pathToFileURL(resolve(REPO_ROOT, 'src', 'terrain', 'FieldLayers.js')).href)

let failures = 0
function expect(name, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const field = createFieldLayers({ cellSize: 1, chunkCells: 4 })

expect('unpainted field reads 0', field.readField(0.5, 0.5) === 0)

field.paint(0.5, 0.5, 2)
expect('runtime paint is summed into read', field.readField(0.5, 0.5) === 2, `got ${field.readField(0.5, 0.5)}`)

const authored = new Float32Array(16)
authored[0] = 3
field.setAuthored(0, 0, authored)
expect('creator layer sums with player layer', field.readField(0.5, 0.5) === 5, `got ${field.readField(0.5, 0.5)}`)
expect('creator layer alone at other cell', field.readField(1.5, 0.5) === 0)

const afterPaint = field.changes(0)
expect('changes(0) lists painted chunk', afterPaint.chunks.includes('0,0'), JSON.stringify(afterPaint))
const cursor = afterPaint.at
expect('changes(at) is empty when nothing moved', field.changes(cursor).chunks.length === 0)

field.paint(9.5, 0.5, 1)
const next = field.changes(cursor)
expect('changes(at) reports only the newly moved chunk', next.chunks.length === 1 && next.chunks[0] === '2,0', JSON.stringify(next))
expect('changes cursor advances', next.at > cursor)

expect('chunk boundary: negative coordinates map to chunk -1', field.locate(-0.5, -0.5).key === '-1,-1')

field.clearRuntime(0, 0)
expect('clearRuntime drops player layer only', field.readField(0.5, 0.5) === 3, `got ${field.readField(0.5, 0.5)}`)
expect('paintedChunks reflects clear', !field.paintedChunks().includes('0,0'))

field.paint(0.5, 0.5, 4)
const cleared = field.clearAllRuntime()
expect('clearAllRuntime reports removed chunks', cleared === 2, `cleared ${cleared}`)
expect('clearAllRuntime leaves creator layer', field.readField(0.5, 0.5) === 3)

let threw = false
try { field.setAuthored(0, 0, new Float32Array(3)) } catch { threw = true }
expect('malformed authored chunk is refused', threw)

threw = false
try { createFieldLayers({ cellSize: 0, chunkCells: 4 }) } catch { threw = true }
expect('zero cellSize is refused at construction', threw)

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('RESULT: PASS')
