/**
 * Multi-Draw Utilities for ANGLE_multi_draw optimization
 *
 * Provides helper functions for batching draw calls using WebGL extensions:
 * - ANGLE_multi_draw: native multi-draw with reduced GPU submission overhead
 * - OES_draw_elements_base_vertex: alternative batching mechanism
 *
 * Goal: Reduce 120 per-slot draw calls to 1-3 GPU submissions per frame
 */

/**
 * Detect WebGL extension support for multi-draw operations
 * @param {WebGLRenderingContext} gl - WebGL context
 * @returns {Object} Supported extensions and capabilities
 */
export function validateExtensionSupport(gl) {
  if (!gl) {
    return {
      supported: false,
      multiDraw: null,
      baseVertex: null,
      reason: 'No WebGL context',
    };
  }

  const multiDraw = gl.getExtension('ANGLE_multi_draw');
  const baseVertex = gl.getExtension('OES_draw_elements_base_vertex');

  return {
    supported: !!(multiDraw || baseVertex),
    multiDraw: multiDraw,
    baseVertex: baseVertex,
    hasMultiDraw: !!multiDraw,
    hasBaseVertex: !!baseVertex,
    reason: multiDraw ? 'ANGLE_multi_draw available' :
            baseVertex ? 'OES_draw_elements_base_vertex available' :
            'No multi-draw extensions available',
  };
}

/**
 * Group draw calls by their OpenGL state (material, geometry, etc.)
 * Organizes instances into batches that can be submitted together
 *
 * @param {Array<Object>} batchedSlots - Array of { batch, count, firstIndex, baseVertex, ... }
 * @returns {Array<Object>} Grouped draw calls with metadata
 */
export function groupDrawCallsByState(batchedSlots) {
  const groups = [];
  let currentGroup = null;

  for (const slot of batchedSlots) {
    // Group by geometry/material state
    // In practice, all slots in a batch share geometry/material via InstancedBatch
    // So we can group by the batch's key
    const stateKey = slot.geoKey || 'default';

    if (!currentGroup || currentGroup.stateKey !== stateKey) {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = {
        stateKey,
        geometry: slot.geometry,
        material: slot.material,
        drawCalls: [],
      };
    }

    currentGroup.drawCalls.push({
      count: slot.count,
      firstIndex: slot.firstIndex,
      baseVertex: slot.baseVertex || 0,
      instanceCount: slot.instanceCount || 1,
      ...slot,
    });
  }

  if (currentGroup) groups.push(currentGroup);
  return groups;
}

/**
 * Create indirect draw buffer for multi-draw operations
 * Format: [count, instanceCount, firstIndex, baseVertex, baseInstance] for each draw
 *
 * @param {Array<Object>} drawCalls - Array of draw call parameters
 * @param {WebGLRenderingContext} gl - WebGL context
 * @returns {WebGLBuffer|null} Indirect draw buffer or null if not applicable
 */
export function createIndirectBuffer(drawCalls, gl) {
  if (!gl || !drawCalls || !drawCalls.length) return null;

  // Each draw call is 5 uint32 values
  const buffer = new Uint32Array(drawCalls.length * 5);
  let offset = 0;

  for (const call of drawCalls) {
    buffer[offset++] = call.count || 0;           // elementCount / vertexCount
    buffer[offset++] = call.instanceCount || 1;   // instanceCount
    buffer[offset++] = call.firstIndex || 0;      // first
    buffer[offset++] = call.baseVertex || 0;      // baseVertex
    buffer[offset++] = 0;                         // baseInstance
  }

  const glBuffer = gl.createBuffer();
  gl.bindBuffer(gl.COPY_READ_BUFFER, glBuffer);
  gl.bufferData(gl.COPY_READ_BUFFER, buffer, gl.STATIC_DRAW);
  gl.bindBuffer(gl.COPY_READ_BUFFER, null);

  return glBuffer;
}

/**
 * Calculate optimal draw call batching strategy
 * Determines how many draw calls can be batched based on extension support
 *
 * @param {Object} extensionSupport - Result from validateExtensionSupport
 * @param {number} drawCallCount - Total number of draw calls to batch
 * @returns {Object} Batching strategy { method, maxCallsPerBatch, estimatedSubmissions, expectedGain }
 */
export function calculateBatchingStrategy(extensionSupport, drawCallCount) {
  if (!extensionSupport.supported || drawCallCount < 2) {
    return {
      method: 'standard',
      maxCallsPerBatch: 1,
      estimatedSubmissions: drawCallCount,
      expectedGain: 0,
      reason: 'No multi-draw support or single draw call',
    };
  }

  // ANGLE_multi_draw: batch all calls into 1-2 submissions
  if (extensionSupport.multiDraw) {
    const estimatedSubmissions = Math.max(1, Math.ceil(drawCallCount / 128)); // reasonable batch size
    const expectedGain = (1 - (estimatedSubmissions / drawCallCount)) * 100;
    return {
      method: 'ANGLE_multi_draw',
      maxCallsPerBatch: 128, // can batch up to 128 before diminishing returns
      estimatedSubmissions,
      expectedGain,
      expectedFpsGain: expectedGain > 80 ? '6-10' : expectedGain > 50 ? '4-6' : '2-4',
      reason: 'ANGLE_multi_draw reduces GPU submission overhead',
    };
  }

  // OES_draw_elements_base_vertex: fallback, less efficient
  if (extensionSupport.baseVertex) {
    const estimatedSubmissions = Math.max(1, Math.ceil(drawCallCount / 32));
    const expectedGain = (1 - (estimatedSubmissions / drawCallCount)) * 100;
    return {
      method: 'OES_draw_elements_base_vertex',
      maxCallsPerBatch: 32, // smaller batch size due to less efficiency
      estimatedSubmissions,
      expectedGain,
      expectedFpsGain: '2-4',
      reason: 'Base-vertex indexing reduces state changes',
    };
  }

  return {
    method: 'standard',
    maxCallsPerBatch: 1,
    estimatedSubmissions: drawCallCount,
    expectedGain: 0,
    reason: 'No supported multi-draw extensions',
  };
}

/**
 * Generate draw call parameters for multi-draw submission
 * Merges individual draw calls into optimized draw lists
 *
 * @param {Array<Object>} drawCalls - Individual draw call data
 * @param {number} maxCallsPerBatch - Maximum calls per batch
 * @returns {Array<Object>} Batched draw call groups
 */
export function generateMultiDrawParams(drawCalls, maxCallsPerBatch = 128) {
  const batches = [];

  for (let i = 0; i < drawCalls.length; i += maxCallsPerBatch) {
    const batchCalls = drawCalls.slice(i, Math.min(i + maxCallsPerBatch, drawCalls.length));

    batches.push({
      count: batchCalls.length,
      calls: batchCalls,
      totalElements: batchCalls.reduce((sum, c) => sum + (c.count || 0), 0),
      firstSubmissionIndex: i,
    });
  }

  return batches;
}

export default {
  validateExtensionSupport,
  groupDrawCallsByState,
  createIndirectBuffer,
  calculateBatchingStrategy,
  generateMultiDrawParams,
};
