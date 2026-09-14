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

export function groupDrawCallsByState(batchedSlots) {
  const groups = [];
  let currentGroup = null;

  for (const slot of batchedSlots) {
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

export function createIndirectBuffer(drawCalls, gl) {
  if (!gl || !drawCalls || !drawCalls.length) return null;

  const buffer = new Uint32Array(drawCalls.length * 5);
  let offset = 0;

  for (const call of drawCalls) {
    buffer[offset++] = call.count || 0;
    buffer[offset++] = call.instanceCount || 1;
    buffer[offset++] = call.firstIndex || 0;
    buffer[offset++] = call.baseVertex || 0;
    buffer[offset++] = 0;
  }

  const glBuffer = gl.createBuffer();
  gl.bindBuffer(gl.COPY_READ_BUFFER, glBuffer);
  gl.bufferData(gl.COPY_READ_BUFFER, buffer, gl.STATIC_DRAW);
  gl.bindBuffer(gl.COPY_READ_BUFFER, null);

  return glBuffer;
}

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

  if (extensionSupport.multiDraw) {
    const estimatedSubmissions = Math.max(1, Math.ceil(drawCallCount / 128));
    const expectedGain = (1 - (estimatedSubmissions / drawCallCount)) * 100;
    return {
      method: 'ANGLE_multi_draw',
      maxCallsPerBatch: 128,
      estimatedSubmissions,
      expectedGain,
      expectedFpsGain: expectedGain > 80 ? '6-10' : expectedGain > 50 ? '4-6' : '2-4',
      reason: 'ANGLE_multi_draw reduces GPU submission overhead',
    };
  }

  if (extensionSupport.baseVertex) {
    const estimatedSubmissions = Math.max(1, Math.ceil(drawCallCount / 32));
    const expectedGain = (1 - (estimatedSubmissions / drawCallCount)) * 100;
    return {
      method: 'OES_draw_elements_base_vertex',
      maxCallsPerBatch: 32,
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
