// OcclusionQueryTier — WebGL2-native GPU occlusion culling for entity roots.
//
// Frustum culling alone (model-pool.js's per-entity sphere test) only rejects
// what's OUTSIDE the view volume; a fully in-frustum entity hidden behind
// another (a wall, a denser model, a cluster of neighbors) still gets its full
// draw submitted every frame. This tier adds the missing "cull each other"
// step using WebGL2's built-in occlusion query objects (gl.beginQuery /
// gl.endQuery with ANY_SAMPLES_PASSED_CONSERVATIVE) — no compute shaders, no
// depth-pyramid infrastructure, works on the stock WebGL2 context this
// renderer already requires.
//
// Two-frame-latency pattern (avoids a GPU sync stall): frame N issues one
// cheap bounding-box depth-only query per frustum-visible entity; frame N+1
// reads back last frame's results (non-blocking — GL guarantees availability
// eventually, we just skip until it's ready) and hides entities whose query
// returned zero samples passed. A freshly-queried-but-not-yet-resolved entity
// stays visible (fail open) so nothing pops out for a frame while its first
// query is in flight.
//
// Query cost scales with entity count, not scene complexity (one query per
// candidate, box geometry, depth-write-disabled, color-write-disabled), so
// this is only enabled for scenes above a size where the query overhead is
// smaller than the geometry it skips (see shouldEnable()).
//
// Draw submission is RAW WebGL2 (own program+VAO+gl.drawElements), not
// renderer.render(scene,camera) per candidate. The previous per-candidate
// renderer.render() call paid three.js's full render-graph walk
// (projectObject/renderBufferDirect/setProgram/refreshUniformsCommon) for a
// single box, up to maxQueriesPerFrame times EVERY frame across every
// OcclusionQueryTier consumer (SceneOcclusion's vegetation/rock/grass
// candidates AND ModelPool's entity occlusion both share this one class) --
// live CPU profile at a forest-edge pose attributed several percent of total
// frame time to exactly those three.js internals, concentrated in this call
// pattern (a real scene amortizes that render-graph walk over hundreds of
// objects in one render() call; this tier was invoking the same walk dozens
// of times per frame just to draw one box each time). Mirrors the raw-GL
// pattern spoint's client/core/TerrainOcclusion.js already uses for the
// identical problem (mapspinner has no THREE dependency there, forcing raw GL
// from the start). Box/AABB math is UNCHANGED (still THREE.Box3/Matrix4 --
// that math was never the profiled cost, only the render-graph walk was), so
// this stays a pure draw-submission swap: same ANY_SAMPLES_PASSED_CONSERVATIVE
// query semantics, same fail-open/resolve/round-robin-budget logic, same
// local-box caching. GPU-visible behavior (what gets queried, when a verdict
// flips) is unchanged; only the CPU path to submit that query is cheaper.

import * as THREE from 'three';

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _boxGeo = new THREE.BoxGeometry(1, 1, 1); // used only to read position attribute data for the raw VBO below
const _scaleMat = new THREE.Matrix4();
const _mvpMat = new THREE.Matrix4();
const _mvpArr = new Float32Array(16);

export class OcclusionQueryTier {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && this.gl instanceof WebGL2RenderingContext;
    // Minimum candidate count before queries are worth their own submission
    // cost — below this, frustum culling alone is already cheap enough.
    this.minCandidates = opts.minCandidates ?? 64;
    // Per-frame query budget: each begin/end query pair carries a real driver
    // cost on some backends (notably ANGLE/D3D11, where query objects map to
    // D3D11 async objects and each box render is its own tiny draw+state
    // round-trip). Unbounded per-candidate issue made the query machinery
    // itself a top CPU cost in large scenes. Cap issues per frame and
    // round-robin the cursor across the candidate list so every candidate
    // still refreshes, just over N/budget frames instead of every frame.
    // Verdicts are sticky between refreshes (isOccluded reads the last
    // resolved result), so slower refresh only delays flips, never pops.
    this.maxQueriesPerFrame = opts.maxQueriesPerFrame ?? 32;
    this._rrCursor = 0;
    this._records = new Map(); // entity -> { query, pending, occluded, localBox, resolves }
    this.stats = { queried: 0, occluded: 0, resolved: 0, supported: this.isWebGL2 };
    this._boxProgram = null;
    this._boxVao = null;
  }

  supported() {
    return this.isWebGL2;
  }

  _ensureBoxGeometry() {
    if (this._boxProgram) return;
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `#version 300 es
      uniform mat4 uMvp;
      layout(location=0) in vec3 aPos;
      void main(){ gl_Position = uMvp * vec4(aPos, 1.0); }`);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
      precision mediump float;
      out vec4 o;
      void main(){ o = vec4(0.0); }`);
    gl.compileShader(fs);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[occlusion-query-tier] box program link failed:', gl.getProgramInfoLog(prog));
      return;
    }
    this._boxProgram = { prog, uMvp: gl.getUniformLocation(prog, 'uMvp') };
    // Reuse THREE.BoxGeometry's own generated position/index data so the raw
    // VBO/IBO are byte-identical to what the old _boxMesh rendered (a
    // THREE.Mesh built from the same BoxGeometry(1,1,1)) -- no hand-authored
    // vertex/index arrays to keep in sync with three's box winding.
    const posAttr = _boxGeo.getAttribute('position');
    const idxAttr = _boxGeo.getIndex();
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, posAttr.array, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxAttr.array, gl.STATIC_DRAW);
    this._boxVao = gl.createVertexArray();
    gl.bindVertexArray(this._boxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bindVertexArray(null);
    this._indexCount = idxAttr.count;
    this._indexType = idxAttr.array instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  }

  // Called once per frame AFTER the main scene render (so the depth buffer
  // holds this frame's real occluders) with the list of frustum-visible
  // entities to test. Issues new queries for each and reads back any queries
  // whose results are now available (from a prior frame).
  runQueries(camera, candidates) {
    if (!this.isWebGL2 || !candidates.length) return;
    const gl = this.gl;
    this._ensureBoxGeometry();
    if (!this._boxProgram) return;

    // 1. Resolve any completed queries from previous frames first (cheap: just
    //    a getParameter poll, no stall — GL never blocks on QUERY_RESULT_AVAILABLE).
    let resolved = 0, occluded = 0;
    for (const [entity, rec] of this._records) {
      if (!rec.pending) continue;
      const available = gl.getQueryParameter(rec.query, gl.QUERY_RESULT_AVAILABLE);
      if (!available) continue;
      const passed = gl.getQueryParameter(rec.query, gl.QUERY_RESULT);
      rec.occluded = passed === 0;
      rec.pending = false;
      rec.resolves = (rec.resolves || 0) + 1;
      resolved++;
      if (rec.occluded) occluded++;
    }
    this.stats.resolved = resolved;
    this.stats.occluded = occluded;

    // Zero-budget fast path: a caller (SceneOcclusion.js's still-camera issue-throttle) sets
    // maxQueriesPerFrame to 0 for a frame where nothing that affects occlusion verdicts could have
    // changed (camera motionless, candidate set unchanged) -- the resolve-poll above still ran (a
    // pending query from a still-active prior issue must keep resolving), but issuing zero NEW
    // queries this frame means the entire block below is dead work: 8 gl.* state-change calls
    // (useProgram/bindVertexArray/colorMask/depthMask/enable x3/depthFunc/polygonOffset) plus
    // renderer.resetState(), each a real driver round-trip on ANGLE/D3D11, for a loop that would
    // execute zero iterations anyway. Skip straight past all of it.
    if (this.maxQueriesPerFrame <= 0) { this.stats.queried = 0; return; }

    // 2. Issue new queries for this frame's candidates, bounded by the
    //    per-frame budget with a round-robin cursor so the whole candidate
    //    set is covered over successive frames.
    gl.useProgram(this._boxProgram.prog);
    gl.bindVertexArray(this._boxVao);
    gl.colorMask(false, false, false, false);
    gl.depthMask(false);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE); // query needs any front-of-depth fragment regardless of winding
    // Anti-z-fight bias (far-candidate-flicker fix): the occluder depth this query tests against is
    // NOT a static baked buffer -- for spoint's terrain-backed consumers it is mapspinner's raw-GL
    // depth-writeback, re-evaluated by a per-vertex fractal height shader EVERY frame, so the exact
    // depth value at a given world position carries floating-point jitter frame-to-frame. The box's
    // own world-space inflation (_size.addScalar above, callers' MARGIN/LIFT) only helps up close --
    // a linear (non-logarithmic) depth buffer compresses nearly all its precision into the first few
    // tens of metres, so at long range (candidate footprint of a few pixels) that same world-space
    // margin projects to a depth-buffer delta smaller than the per-frame jitter, letting the box's
    // nearest fragment flip between marginally-in-front and marginally-behind the freshly-redrawn
    // terrain depth -- read live as "far object appears/disappears" (occlusion verdict flip) even
    // though nothing about visibility actually changed. POLYGON_OFFSET pulls the rasterized box depth
    // toward the camera by an amount that scales with the fragment's own depth-slope (factor) plus a
    // small constant NDC-Z bias (units) -- unlike a fixed world-space epsilon, this stays proportional
    // to the local depth-buffer step size at ANY range, so it remains meaningful once world-space
    // margins have become sub-quantum. Only affects this query draw (state reset after, matching the
    // existing colorMask/depthMask/cull restore below).
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-4, -8);

    let queried = 0;
    const n = candidates.length;
    const budget = this.maxQueriesPerFrame;
    if (this._rrCursor >= n) this._rrCursor = 0;
    let idx = this._rrCursor;
    for (let examined = 0; examined < n && queried < budget; examined++, idx = (idx + 1) % n) {
      const entity = candidates[idx];
      let rec = this._records.get(entity);
      if (!rec) {
        rec = { query: gl.createQuery(), pending: false, occluded: false };
        this._records.set(entity, rec);
      }
      if (rec.pending) continue; // previous query still in flight, don't double-issue

      // Cache the LOCAL-space AABB once per entity (full subtree traversal +
      // geometry-bounds union is expensive and this tier's candidates are
      // static-geometry model-pool entities -- their mesh/geometry never
      // changes after creation, only entity.root's transform moves). Computed
      // ONCE by taking the current world-space box and un-transforming it by
      // the inverse of the CURRENT matrixWorld (no mutation of entity.root,
      // safe regardless of what else touches its transform this frame). Every
      // subsequent frame just re-derives the world AABB from the cached local
      // box + entity's CURRENT matrixWorld via Box3.applyMatrix4 (the standard
      // re-derive-min/max-from-basis-vectors trick) instead of a full
      // subtree retraversal. (Identical to the pre-rewrite logic -- only the
      // draw submission below changed.)
      if (!rec.localBox) {
        entity.root.updateWorldMatrix(true, true);
        const worldBox = new THREE.Box3().setFromObject(entity.root);
        if (worldBox.isEmpty()) { rec.localBox = null; }
        else {
          const invMatrix = new THREE.Matrix4().copy(entity.root.matrixWorld).invert();
          rec.localBox = worldBox.applyMatrix4(invMatrix);
        }
      }
      if (!rec.localBox) continue;
      _box.copy(rec.localBox).applyMatrix4(entity.root.matrixWorld);
      if (_box.isEmpty()) continue;
      _box.getSize(_size);
      _box.getCenter(_center);
      _size.addScalar(1e-4);

      // Compose MVP for a unit box scaled+translated to [_center,_size] -- same
      // transform the old _boxMesh.position/.scale/.updateMatrixWorld produced,
      // now folded directly into one matrix instead of mutating a THREE.Object3D
      // and letting renderer.render() walk it through the full render graph.
      _scaleMat.makeScale(_size.x, _size.y, _size.z);
      _scaleMat.setPosition(_center);
      _mvpMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _mvpMat.multiply(_scaleMat);
      _mvpMat.toArray(_mvpArr);

      gl.uniformMatrix4fv(this._boxProgram.uMvp, false, _mvpArr);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, rec.query);
      gl.drawElements(gl.TRIANGLES, this._indexCount, this._indexType, 0);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
      rec.pending = true;
      queried++;
    }
    this._rrCursor = idx;
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    // Restore three.js's expected GL state assumptions for its own next
    // render() call: three tracks depth/cull/colorMask/program/VAO state
    // itself via its internal state cache and does not blindly re-issue
    // redundant state changes it believes are already in place, so any raw-GL
    // mutation here that diverges from three's cached state must be reset
    // before returning control to the normal render loop.
    this.renderer.resetState();
    // Explicit flush: without it, driver-queued query commands can sit
    // unsubmitted indefinitely on some configurations (observed: queries
    // issued this way never resolved QUERY_RESULT_AVAILABLE across hundreds
    // of frames in a busy scene, despite an isolated single-query repro
    // resolving in 2-3 frames) -- flush forces the commands out of the
    // client-side queue so the GPU can actually retire them.
    if (queried > 0) gl.flush();
    this.stats.queried = queried;
  }

  // Fail-open: an entity with no resolved query yet, or one whose LAST
  // resolved query saw samples pass, is NOT occluded. `rec.occluded` already
  // holds only a resolved verdict (set exclusively in the resolve pass above
  // when QUERY_RESULT_AVAILABLE was true) -- `rec.pending` tracks whether a
  // FRESH query is currently in flight for the NEXT verdict, which is
  // orthogonal: a query is re-issued every frame a candidate is visible, so
  // requiring !pending here would almost always be false at steady state
  // (this frame's fresh query is essentially always in flight) and the
  // occlusion gate would never fire in practice.
  isOccluded(entity) {
    const rec = this._records.get(entity);
    return !!rec && rec.occluded;
  }

  // Monotonic count of resolved queries for this entity — lets consumers with
  // their own hysteresis (consecutive-hidden-resolve streaks) distinguish a
  // FRESH resolve from a stale verdict re-read, which matters now that the
  // per-frame budget means a given candidate only refreshes every
  // candidates/budget frames.
  getResolveCount(entity) {
    const rec = this._records.get(entity);
    return rec ? (rec.resolves || 0) : 0;
  }

  release(entity) {
    const rec = this._records.get(entity);
    if (!rec) return;
    this.gl.deleteQuery(rec.query);
    this._records.delete(entity);
  }

  dispose() {
    const gl = this.gl;
    for (const rec of this._records.values()) gl.deleteQuery(rec.query);
    this._records.clear();
    if (this._boxProgram) { gl.deleteProgram(this._boxProgram.prog); this._boxProgram = null; }
    if (this._boxVao) { gl.deleteVertexArray(this._boxVao); this._boxVao = null; }
  }
}
