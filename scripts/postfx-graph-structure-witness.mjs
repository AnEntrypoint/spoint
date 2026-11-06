import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

assert.equal(typeof window, 'undefined', 'the check runs without a browser window')
assert.equal(typeof document, 'undefined', 'the check runs without a document')

await installSpecifierHooks()
const { parsePostFxLook, postfxLookNode } = await import('../client/core/PostFxLook.js')
const { createRenderGraph } = await import('../client/core/RenderGraph.js')

const node = postfxLookNode()
assert.equal(node.id, 'postfx-look')
assert.deepEqual(node.reads, [], 'the look node reads no upstream resource')
assert.deepEqual(node.writes, ['postfxPasses'])
assert.equal(node.terminal, true)
assert.equal(typeof node.shouldRun, 'function')
assert.equal(typeof node.run, 'function')

const graph = createRenderGraph([node])
assert.equal(typeof graph.run, 'function', 'the graph builds from the node with no renderer')

const ctx = { res: {}, postfxLook: parsePostFxLook({ saturation: 0.5, exposure: 2 }) }
graph.run(ctx)
assert.deepEqual(ctx.res.postfxPasses, [{ op: 'exposure', value: 2 }, { op: 'saturation', value: 0.5 }], 'the built graph writes the ordered passes')

const source = readFileSync('client/core/PostFxLook.js', 'utf8')
assert.ok(!/from\s+['"]three/.test(source), 'PostFxLook.js has no three.js import, so it needs no renderer')

console.log('RESULT: PASS structural check: postfxLookNode builds a render-graph node with no window, document or renderer, and the built graph writes the ordered look passes')
