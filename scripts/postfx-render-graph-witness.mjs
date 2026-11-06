import assert from 'node:assert/strict'
import { installSpecifierHooks } from './lib/install-specifier-hooks.mjs'

await installSpecifierHooks()
const { parsePostFxLook, lookPasses, postfxLookNode } = await import('../client/core/PostFxLook.js')
const { createRenderGraph } = await import('../client/core/RenderGraph.js')

assert.deepEqual(lookPasses(parsePostFxLook({ saturation: 0.5, exposure: 2 })), [{ op: 'exposure', value: 2 }, { op: 'saturation', value: 0.5 }], 'passes follow the operator order')
assert.deepEqual(lookPasses(parsePostFxLook({})), [], 'an empty look has no passes')

const graph = createRenderGraph([postfxLookNode()])
const ctx = { res: {}, postfxLook: parsePostFxLook({ vignette: 0.3 }) }
graph.run(ctx)
assert.deepEqual(ctx.res.postfxPasses, [{ op: 'vignette', value: 0.3 }], 'the graph node writes the look passes')

const idle = { res: {}, postfxLook: null }
graph.run(idle)
assert.equal(idle.res.postfxPasses, undefined, 'no look means the node does not run')
console.log('RESULT: PASS the postfx look is a render-graph node: it writes ordered look passes into res when a look is set, and stays idle when none is set')
