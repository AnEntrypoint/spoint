import {
  validateExtensionSupport,
  groupDrawCallsByState,
  generateMultiDrawParams,
  calculateBatchingStrategy,
} from './multi-draw-utils.js';

export class MultiDrawOptimizer {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.opts = opts || {};

    const canvas = renderer.domElement;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    this.extensionSupport = validateExtensionSupport(gl);

    if (this.extensionSupport.supported) {
      console.log(
        '[multi-draw] Extensions available:',
        `multiDraw=${this.extensionSupport.hasMultiDraw}, baseVertex=${this.extensionSupport.hasBaseVertex}`,
        this.extensionSupport.reason
      );
    } else {
      console.log('[multi-draw] No multi-draw extensions available, using standard fallback');
    }

    this._multiDrawCalls = [];
    this._currentBatch = null;
    this._drawCallCount = 0;

    this._stats = {
      enabled: this.extensionSupport.supported,
      extensionSupport: this.extensionSupport,
      drawCallsReduced: 0,
      submissionsPerFrame: 0,
      lastFrameMs: 0,
      strategy: null,
    };

    this.enabled = this.extensionSupport.supported;
  }

  enableMultiDraw(batchMap) {
    if (!this.enabled || !batchMap) return [];

    this._drawCallCount = batchMap.size;
    const drawCalls = [];

    for (const [geoKey, batch] of batchMap) {
      if (!batch.mesh || batch.mesh.count === 0) continue;

      drawCalls.push({
        geoKey,
        batch,
        geometry: batch.geometry,
        material: batch.material,
        count: batch.mesh.count,
        firstIndex: 0,
        baseVertex: 0,
        instanceCount: batch.mesh.count,
      });
    }

    const groupedCalls = groupDrawCallsByState(drawCalls);

    const strategy = calculateBatchingStrategy(
      this.extensionSupport,
      drawCalls.length
    );
    this._stats.strategy = strategy;
    this._stats.submissionsPerFrame = strategy.estimatedSubmissions;
    this._stats.drawCallsReduced = drawCalls.length - strategy.estimatedSubmissions;

    if (this.opts.verbose) {
      console.log(`[multi-draw] Batching ${drawCalls.length} draw calls → ${strategy.estimatedSubmissions} submissions (${strategy.expectedGain.toFixed(1)}% reduction)`);
    }

    return {
      groupedCalls,
      strategy,
      drawCallCount: drawCalls.length,
      originalDrawCalls: drawCalls,
    };
  }

  createMultiDrawParams(batchData) {
    if (!batchData || !batchData.originalDrawCalls) return null;

    const { originalDrawCalls, strategy } = batchData;
    const multiDrawParams = generateMultiDrawParams(
      originalDrawCalls,
      strategy.maxCallsPerBatch || 128
    );

    return {
      batches: multiDrawParams,
      strategy: strategy.method,
      callCount: originalDrawCalls.length,
      submissionCount: multiDrawParams.length,
    };
  }

  renderMultiDraw(batchData, renderContext = {}) {
    if (!this.enabled || !batchData) {
      return { drawCalls: 0, submissionsUsed: 0, timeMs: 0, method: 'none' };
    }

    const t0 = performance.now();
    const { groupedCalls, originalDrawCalls } = batchData;
    let submissionCount = 0;

    if (this.extensionSupport.hasMultiDraw) {
      submissionCount = this._renderMultiDrawANGLE(groupedCalls);
    }
    else if (this.extensionSupport.hasBaseVertex) {
      submissionCount = this._renderBaseVertex(groupedCalls);
    }
    else {
      submissionCount = this._renderStandard(groupedCalls);
    }

    const timeMs = performance.now() - t0;
    this._stats.lastFrameMs = timeMs;

    return {
      drawCalls: originalDrawCalls.length,
      submissionsUsed: submissionCount,
      method: this.extensionSupport.hasMultiDraw ? 'ANGLE_multi_draw' :
              this.extensionSupport.hasBaseVertex ? 'OES_draw_elements_base_vertex' :
              'standard',
      timeMs,
    };
  }

  _renderMultiDrawANGLE(groupedCalls) {
    const ext = this.extensionSupport.multiDraw;
    if (!ext) return 0;

    let submissionCount = 0;

    for (const group of groupedCalls) {
      const { drawCalls } = group;
      if (!drawCalls.length) continue;

      const counts = [];
      const offsets = [];
      const baseVertices = [];
      const baseInstances = [];
      const instanceCounts = [];

      for (const call of drawCalls) {
        counts.push(call.count || 0);
        offsets.push(call.firstIndex || 0);
        baseVertices.push(call.baseVertex || 0);
        baseInstances.push(0);
        instanceCounts.push(call.instanceCount || 1);
      }

      const countArray = new Int32Array(counts);
      const offsetArray = new Int32Array(offsets);
      const baseVertexArray = new Int32Array(baseVertices);
      const baseInstanceArray = new Uint32Array(baseInstances);
      const instanceCountArray = new Int32Array(instanceCounts);

      try {
        ext.multiDrawElementsANGLE(
          this.renderer.getContext().TRIANGLES,
          countArray, 0,
          offsetArray, 0,
          baseVertexArray, 0,
          baseInstanceArray, 0,
          instanceCountArray, 0,
          drawCalls.length
        );
        submissionCount++;
      } catch (e) {
        console.warn('[multi-draw] ANGLE submission failed, falling back', e);
        return this._renderStandard(groupedCalls);
      }
    }

    return submissionCount;
  }

  _renderBaseVertex(groupedCalls) {
    const ext = this.extensionSupport.baseVertex;
    if (!ext) return 0;

    const gl = this.renderer.getContext();
    let submissionCount = 0;

    for (const group of groupedCalls) {
      const { drawCalls } = group;
      if (!drawCalls.length) continue;

      for (const call of drawCalls) {
        try {
          ext.drawElementsBaseVertexOES(
            gl.TRIANGLES,
            call.count || 0,
            gl.UNSIGNED_INT,
            (call.firstIndex || 0) * 4,
            call.baseVertex || 0
          );
          submissionCount++;
        } catch (e) {
          console.warn('[multi-draw] Base-vertex submission failed', e);
        }
      }
    }

    return submissionCount;
  }

  _renderStandard(groupedCalls) {
    const renderer = this.renderer;
    let submissionCount = 0;

    for (const group of groupedCalls) {
      const { batch } = group.drawCalls[0] || {};
      if (!batch) continue;

      try {
        renderer.render(batch.mesh, { camera: { projectionMatrix: {} } });
        submissionCount++;
      } catch (e) {
      }
    }

    return submissionCount;
  }

  getStats() {
    return {
      ...this._stats,
      enabled: this.enabled,
      method: this.extensionSupport.hasMultiDraw ? 'ANGLE_multi_draw' :
              this.extensionSupport.hasBaseVertex ? 'OES_draw_elements_base_vertex' :
              'standard',
    };
  }

  isEnabled() {
    return this.enabled && this.extensionSupport.supported;
  }

  getStatusString() {
    if (!this.enabled) {
      return 'multi-draw: not supported (fallback)';
    }
    if (this.extensionSupport.hasMultiDraw) {
      return 'multi-draw: ANGLE_multi_draw enabled';
    }
    if (this.extensionSupport.hasBaseVertex) {
      return 'multi-draw: OES_draw_elements_base_vertex enabled';
    }
    return 'multi-draw: fallback mode';
  }
}

export default MultiDrawOptimizer;
