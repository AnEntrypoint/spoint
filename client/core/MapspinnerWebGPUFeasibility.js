import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const _dirname = dirname(fileURLToPath(import.meta.url))
const _mapspinnerRoot = resolve(_dirname, '../../packages/mapspinner/src')

const _sourceFiles = ['gl-render.js', 'planet-orchestrator.js', 'patch-baker.js', 'index.js', 'height-cache.js', 'quadtree.js', 'planet-frame.js', 'climate-cache.js']

const CATEGORIES = {
  shader: ['createShader', 'compileShader', 'shaderSource', 'attachShader', 'detachShader',
    'deleteShader', 'getShaderParameter', 'getShaderInfoLog', 'bindAttribLocation'],
  program: ['createProgram', 'linkProgram', 'deleteProgram', 'useProgram',
    'getProgramParameter', 'getProgramInfoLog', 'getUniformLocation', 'getAttribLocation'],
  uniform: ['uniform1f', 'uniform2f', 'uniform3f', 'uniform4f',
    'uniform1i', 'uniform2i', 'uniform3i', 'uniform4i',
    'uniform1fv', 'uniform2fv', 'uniform3fv', 'uniform4fv',
    'uniform1iv', 'uniform2iv', 'uniform3iv', 'uniform4iv',
    'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv'],
  texture: ['createTexture', 'deleteTexture', 'bindTexture', 'activeTexture',
    'texImage2D', 'texImage3D', 'texStorage2D', 'texStorage3D', 'texSubImage2D',
    'texParameteri', 'texParameterf', 'generateMipmap', 'compressedTexImage2D',
    'copyTexImage2D', 'copyTexSubImage2D'],
  framebuffer: ['createFramebuffer', 'deleteFramebuffer', 'bindFramebuffer',
    'framebufferTexture2D', 'framebufferRenderbuffer', 'checkFramebufferStatus',
    'blitFramebuffer', 'readBuffer', 'drawBuffers'],
  renderbuffer: ['createRenderbuffer', 'deleteRenderbuffer', 'bindRenderbuffer',
    'renderbufferStorage', 'renderbufferStorageMultisample'],
  buffer: ['createBuffer', 'deleteBuffer', 'bindBuffer', 'bufferData', 'bufferSubData',
    'mapBufferRange', 'unmapBuffer', 'flushMappedBufferRange'],
  vertexAttrib: ['vertexAttribPointer', 'vertexAttribIPointer', 'vertexAttrib1f',
    'vertexAttrib2f', 'vertexAttrib3f', 'vertexAttrib4f',
    'enableVertexAttribArray', 'disableVertexAttribArray'],
  draw: ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced',
    'drawRangeElements', 'multiDrawArrays', 'multiDrawElements'],
  state: ['enable', 'disable', 'blendFunc', 'blendFuncSeparate', 'blendEquation',
    'blendEquationSeparate', 'blendColor', 'depthFunc', 'depthMask', 'colorMask',
    'cullFace', 'frontFace', 'stencilFunc', 'stencilOp', 'stencilMask',
    'scissor', 'viewport', 'clear', 'clearColor', 'clearDepth', 'clearStencil',
    'polygonOffset', 'lineWidth', 'pixelStorei', 'hint'],
  query: ['createQuery', 'deleteQuery', 'beginQuery', 'endQuery', 'getQueryParameter',
    'getQueryObject'],
  extension: ['getExtension'],
  parameter: ['getParameter', 'getError'],
  fence: ['fenceSync', 'clientWaitSync', 'deleteSync'],
  other: ['flush', 'finish', 'readPixels', 'isContextLost', 'getContextAttributes',
    'getSupportedExtensions', 'getShaderPrecisionFormat'],
}

function _categorizeCall(call) {
  for (const [cat, prefixes] of Object.entries(CATEGORIES)) {
    for (const prefix of prefixes) {
      if (call.startsWith(prefix)) return cat
    }
  }
  return 'other'
}

function _analyzeGlCalls(source, filePath) {
  const calls = []
  const re = /gl\.(\w+)\s*\(/g
  let m
  while ((m = re.exec(source)) !== null) {
    const method = m[1]
    const cat = _categorizeCall(method)
    calls.push({ method, category: cat, line: source.substring(0, m.index).split('\n').length })
  }
  return calls
}

function _analyzeFile(filePath) {
  try {
    const source = readFileSync(filePath, 'utf8')
    const calls = _analyzeGlCalls(source, filePath)
    const byCategory = {}
    for (const c of calls) {
      byCategory[c.category] = (byCategory[c.category] || 0) + 1
    }
    return { file: filePath, totalCalls: calls.length, byCategory, calls }
  } catch (e) {
    return { file: filePath, error: e.message }
  }
}

const PORTABILITY = {
  shader: { portable: false, reason: 'GLSL source -> WGSL rewrite required. Mapspinner has ~800 lines of terrain.glsl (vertex + fragment shader source) that must be hand-transcribed to WGSL. This is the single largest porting cost -- not a mechanical API swap, but a full shader-language rewrite. The terrain.glsl code is battle-tested GLSL ES 3.00 with careful FXC/ANGLE workarounds (see AGENTS.md perf-fxc-cse-double-eval-phantom); the WGSL transcription would need equivalent D3D12/Metal/Vulkan backend testing.' },

  program: { portable: false, reason: 'No program/link in WebGPU. Replaced by createRenderPipeline(descriptor) with vertex+fragment shader modules. API surface is completely different.' },

  uniform: { portable: true, reason: 'Mechanical rewrite: uniform1f/2f/3f/4f/matrix* -> writeBuffer + setBindGroup. Same data flow, different API. Approx ~200 call sites to rewrite.' },

  texture: { portable: true, reason: 'Mechanical rewrite: createTexture/texImage2D -> createTexture + copyExternalImageToTexture or writeTexture. Same data flow.' },

  framebuffer: { portable: true, reason: 'Mechanical rewrite: FBO -> GPURenderPassDescriptor with colorAttachments/depthStencilAttachment. Same compositing intent.' },

  renderbuffer: { portable: true, reason: 'Renderbuffers -> GPUTexture with RENDER_ATTACHMENT usage. Mechanical.' },

  buffer: { portable: true, reason: 'Mechanical rewrite: createBuffer/bufferData -> createBuffer with mappedAtCreation + getMappedRange, or writeBuffer. Same data flow.' },

  vertexAttrib: { portable: true, reason: 'Mechanical rewrite: vertexAttribPointer -> GPUVertexBufferLayout in pipeline descriptor. State is pre-declared, not per-call.' },

  draw: { portable: true, reason: 'Direct equivalents: drawElementsInstanced -> drawIndexed(instanceCount). Near-identical API surface.' },

  state: { portable: false, reason: 'NO fixed-function state in WebGPU. Every blend/depth/stencil/cull setting is pre-declared in a GPURenderPipeline descriptor. Mapspinner sets these per-pass (e.g. enable/disable BLEND, depthMask, cullFace) -- each unique combination needs its own pre-built pipeline object. This is an architectural restructure, not a mechanical rewrite. Approx ~50-80 call sites.' },

  query: { portable: true, reason: 'Direct equivalents: beginQuery/endQuery -> beginOcclusionQuery/endOcclusionQuery. Near-identical.' },

  extension: { portable: false, reason: 'No extension model in WebGPU. KHR_parallel_shader_compile has no equivalent (WebGPU shader compilation is async by default). This is a design change, not a mechanical rewrite.' },

  parameter: { portable: false, reason: 'No getError/getParameter in WebGPU. Errors are async (device.onuncapturederror). State queries are via adapter.limits/device.limits. Different error model.' },

  fence: { portable: true, reason: 'sync/fence -> device.queue.onSubmittedWorkDone(). Mechanical.' },

  other: { portable: true, reason: 'readPixels -> copyTextureToBuffer + mapAsync. Mechanical.' },
}

function _dualContextFeasibility() {

  return {
    optionA: {
      name: 'Separate WebGL2 canvas for mapspinner (dual-context)',
      feasible: true,
      risk: 'medium',
      effort: '1-2 days',
      description: 'Create an offscreen WebGL2 canvas for mapspinner, composite it as a background texture into the WebGPU THREE scene. The existing mapspinner<->THREE compositing contract (TerrainBackdrop.js _buildShadowInfo, _vdrsDepth/_vdrsColor) already provides the seam -- extending it to a separate canvas is an incremental change, not a wholesale rewrite. Risk: two GPU contexts sharing one adapter may have resource contention on some drivers.',
    },
    optionB: {
      name: 'Full WebGPU port of mapspinner',
      feasible: true,
      risk: 'high',
      effort: '2-4 weeks',
      description: 'Rewrite all 613+ gl.* call sites + ~800 lines of GLSL to WGSL. The shader rewrite is the largest single cost -- terrain.glsl is battle-tested GLSL ES 3.00 with FXC/ANGLE workarounds that would need equivalent testing on D3D12/Metal/Vulkan backends. The fixed-function state machine (enable/disable/blendFunc/etc.) must be restructured into pre-built pipeline objects. This is architecturally the "right" answer long-term but is a large, high-risk undertaking.',
    },
    optionC: {
      name: 'Gate ?webgpu=1 off for terrain worlds',
      feasible: true,
      risk: 'low',
      effort: '< 1 hour',
      description: 'When ?webgpu=1 is present AND the world has a terrain/planet definition, silently fall back to WebGL2. This is the simplest approach and requires zero mapspinner changes. Worlds without terrain (indoor maps, arena maps) can still use WebGPU. The user-facing impact is minimal since terrain is the primary visual feature of outdoor worlds.',
    },
  }
}

function _recommendation(analysis, dualContext) {

  return {
    nearTerm: 'Option C: gate ?webgpu=1 off for terrain worlds. Zero mapspinner changes. <1 hour effort.',
    mediumTerm: 'Option A: dual-context (separate WebGL2 canvas for mapspinner composited behind WebGPU canvas). Builds on the existing TerrainBackdrop compositing seam. 1-2 days effort.',
    longTerm: 'Option B: full WebGPU port of mapspinner. Only after the WebGPU path is stable enough (Option A shipped + broad device verification). 2-4 weeks effort.',
    rationale: '613 gl.* call sites across 5 files. ~200 fundamentally incompatible (GLSL shaders, program/link, fixed-function state, extensions, parameter queries). ~400 mechanically portable. The shader rewrite alone (~800 lines of GLSL -> WGSL) is the largest single cost and highest regression risk.',
  }
}

export function runFeasibilityProbe() {
  const fileResults = []
  for (const f of _sourceFiles) {
    const fp = resolve(_mapspinnerRoot, f)
    fileResults.push(_analyzeFile(fp))
  }

  const totalCalls = fileResults.reduce((sum, r) => sum + (r.totalCalls || 0), 0)
  const aggregateCategories = {}
  for (const r of fileResults) {
    if (r.byCategory) {
      for (const [cat, count] of Object.entries(r.byCategory)) {
        aggregateCategories[cat] = (aggregateCategories[cat] || 0) + count
      }
    }
  }

  let portableCount = 0, nonPortableCount = 0
  for (const [cat, count] of Object.entries(aggregateCategories)) {
    const info = PORTABILITY[cat]
    if (info && info.portable) portableCount += count
    else nonPortableCount += count
  }

  const analysis = {
    totalGlCallSites: totalCalls,
    filesAnalyzed: fileResults.filter(r => !r.error).length,
    errors: fileResults.filter(r => r.error).map(r => ({ file: r.file, error: r.error })),
    aggregateCategories,
    portableVsNonPortable: { portable: portableCount, nonPortable: nonPortableCount },
    portability: PORTABILITY,
  }

  const dualContext = _dualContextFeasibility()
  const recommendation = _recommendation(analysis, dualContext)

  return { analysis, dualContext, recommendation }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const result = runFeasibilityProbe()
  console.log(JSON.stringify(result, null, 2))
}