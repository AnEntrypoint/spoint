import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const PINNED_VERSIONS = {
  '@three.ez/instanced-mesh': '0.3.16',
  'bvh.js': '0.0.13',
  'msgpackr': '2.0.4',
  'three': '0.185.1'
}

function checkPinnedVersion(pkgName) {
  const pinned = PINNED_VERSIONS[pkgName]
  if (!pinned) return
  const pkgJsonUrl = new URL(`../node_modules/${pkgName}/package.json`, import.meta.url)
  if (!existsSync(pkgJsonUrl)) return
  let installed
  try {
    installed = JSON.parse(readFileSync(pkgJsonUrl, 'utf8')).version
  } catch (e) {
    console.error(`[patch-deps] FATAL: could not read ${pkgName}/package.json to verify version: ${e.message}`)
    process.exit(1)
  }
  if (installed !== pinned) {
    console.error(`[patch-deps] FATAL: ${pkgName} version mismatch -- installed ${installed}, patches in this file were verified against ${pinned}.`)
    console.error(`[patch-deps] The patch anchors are literal source-text matches against the pinned version; applying them against a different version risks a silent wrong-logic patch even if the anchor text happens to still match.`)
    console.error(`[patch-deps] Re-verify each patch's anchor/replacement against the new version's source, then update PINNED_VERSIONS in scripts/patch-deps.mjs.`)
    process.exit(1)
  }
}

function patch(relPath, marker, anchor, replacement, label, strict) {
  const file = new URL('../' + relPath, import.meta.url)
  const fatal = reason => {
    console.error(`[patch-deps] FATAL: ${label}: ${reason}`)
    console.error(`[patch-deps] ${label}: this patch is load-bearing for ${relPath}; refusing to leave an install without it applied.`)
    console.error(`[patch-deps] ${label}: re-verify the anchor against the installed source, then update it in scripts/patch-deps.mjs.`)
    process.exit(1)
  }
  if (!existsSync(file)) {
    if (strict) fatal(`${relPath} is not installed`)
    console.log(`[patch-deps] ${label}: not installed; skipping`)
    return
  }
  const pkgMatch = relPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  if (pkgMatch) checkPinnedVersion(pkgMatch[1])
  const src = readFileSync(file, 'utf8')
  if (src.includes(marker)) { console.log(`[patch-deps] ${label}: already present (published or patched); no-op`); return }
  if (!src.includes(anchor)) {
    if (strict) fatal(`anchor not found in ${relPath} -- upstream shape changed`)
    console.warn(`[patch-deps] ${label}: anchor not found -- upstream shape changed; skipping (verify the fix manually)`)
    return
  }
  writeFileSync(file, src.replace(anchor, replacement), 'utf8')
  console.log(`[patch-deps] ${label}: injected`)
}

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] three r183',
  `const { vertex: l, fragment: d } = this.uniformsTexture.getUniformsGLSL("uniformsTexture", "instanceIndex", "uint");
        h.vertexShader = h.vertexShader.replace("void main() {", l), h.fragmentShader = h.fragmentShader.replace("void main() {", d);`,
  `const { vertex: l, fragment: d } = this.uniformsTexture.getUniformsGLSL("uniformsTexture", "instanceIndex", "uint");
        // [spoint patch] three r183: custom/depth materials may lack <batching_pars_vertex> (which carries
        // the lib's appended \`attribute uint instanceIndex\` decl) -> the injected uniforms block referenced
        // an UNDECLARED instanceIndex -> compile fail -> broken program/fps collapse. Prepend the decl when
        // that chunk is absent (skip when present to avoid a redefinition).
        const _ezDecl = "#ifdef USE_INSTANCING_INDIRECT\\n\\tattribute highp uint instanceIndex;\\n#endif\\n";
        const _lv = h.vertexShader.includes("#include <batching_pars_vertex>") ? l : (_ezDecl + l);
        h.vertexShader = h.vertexShader.replace("void main() {", _lv), h.fragmentShader = h.fragmentShader.replace("void main() {", d);`,
  'three.ez instanceIndex decl'
)

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] instanceIndex decl guard: instanced_pars_vertex',
  `const _lv = h.vertexShader.includes("#include <batching_pars_vertex>") ? l : (_ezDecl + l);`,
  `// [spoint patch] instanceIndex decl guard: instanced_pars_vertex -- '#include <instanced_pars_vertex>'
        // (this codebase's own instanceIndex-undeclared fix sites: Grass.js/Weather.js/Vegetation.js/
        // SSAO.js) ALSO declares instanceIndex, same as '#include <batching_pars_vertex>'; recognizing
        // only the latter caused a real 'instanceIndex : redefinition' compile failure (unlinked program
        // -> every later useProgram() call on it rejected by the GL driver) whenever a uniformsTexture-
        // bearing InstancedMesh2 (e.g. Weather.js's rain-splash pool, via initUniformsPerInstance) got
        // patched against one of those shaders (e.g. SSAO's shared scene.overrideMaterial G-buffer pass).
        const _hasInstanceIndexDecl = h.vertexShader.includes("#include <batching_pars_vertex>") || h.vertexShader.includes("#include <instanced_pars_vertex>");
        const _lv = _hasInstanceIndexDecl ? l : (_ezDecl + l);`,
  'three.ez instanceIndex decl guard gap (instanced_pars_vertex, useProgram-invalid root cause)'
)

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] bindTextures',
  `const a = t.getContext(), c = s.getUniforms().map, h = a.getParameter(a.CURRENT_PROGRAM);
    t.state.useProgram(o), this.matricesTexture.bindToProgram(t, a, c, i, "matricesTexture"), this.colorsTexture?.bindToProgram(t, a, c, i, "colorsTexture"), this.uniformsTexture?.bindToProgram(t, a, c, i, "uniformsTexture"), this.boneTexture?.bindToProgram(t, a, c, i, "boneTexture"), t.state.useProgram(h);`,
  `const a = t.getContext(), c = s.getUniforms().map;
    // [spoint patch] bindTextures: dropped the getParameter(CURRENT_PROGRAM) read + restoring useProgram(h)
    // -- three's WebGLState.useProgram is a tracked cache, so after useProgram(o) the tracked program IS o,
    // and WebGLRenderer.setProgram re-establishes the correct program via the same tracked path before any
    // draw runs; nothing between here and the next draw reads gl.CURRENT_PROGRAM directly.
    t.state.useProgram(o), this.matricesTexture.bindToProgram(t, a, c, i, "matricesTexture"), this.colorsTexture?.bindToProgram(t, a, c, i, "colorsTexture"), this.uniformsTexture?.bindToProgram(t, a, c, i, "uniformsTexture"), this.boneTexture?.bindToProgram(t, a, c, i, "boneTexture");`,
  'three.ez bindTextures redundant program restore'
)

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'spoint patch] BVH LOD hysteresis',
  `    for (let a = 0; a < n.length; a++)
      s[a] = n[a].distance;`,
  `    // [spoint patch] BVH LOD hysteresis: shrink by the level's own hysteresis fraction (matches
    // getObjectLODIndexForDistance's levelDistance = distance - distance*hysteresis) so bvh.js's
    // internal-node showAll fast path (which has NO hysteresis of its own -- see its "if we want to
    // add hysteresis" TODO) can never disagree with the precise per-instance fallback near a cutover.
    for (let a = 0; a < n.length; a++)
      s[a] = n[a].distance - n[a].distance * n[a].hysteresis;`,
  'three.ez BVH LOD hysteresis (trunk-flicker root cause)'
)

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  't.deferUnreadyPrograms === true && !s.isReady()',
  `    const s = n.currentProgram, o = s?.program;
    if (!o) return;`,
  `    const s = n.currentProgram, o = s?.program;
    if (!o || (t.deferUnreadyPrograms === true && !s.isReady())) return;`,
  'three.ez bindTextures skips a still-compiling program'
)

patch(
  'node_modules/three/build/three.module.js',
  '_this.deferUnreadyPrograms === true && program.isReady() === false',
  `\t\t\tlet refreshProgram = false;\n\t\t\tlet refreshMaterial = false;\n\t\t\tlet refreshLights = false;\n\n\t\t\tconst p_uniforms = program.getUniforms(),`,
  `\t\t\tif ( _this.deferUnreadyPrograms === true && program.isReady() === false ) { _this.deferredProgramDraws ++; return null; }\n\n\t\t\tlet refreshProgram = false;\n\t\t\tlet refreshMaterial = false;\n\t\t\tlet refreshLights = false;\n\n\t\t\tconst p_uniforms = program.getUniforms(),`,
  'three setProgram defers a still-compiling program'
)

patch(
  'node_modules/three/build/three.module.js',
  'const program = setProgram( camera, scene, geometry, material, object );\n\t\t\tif ( program === null ) return;',
  `\t\t\tconst program = setProgram( camera, scene, geometry, material, object );\n`,
  `\t\t\tconst program = setProgram( camera, scene, geometry, material, object );\n\t\t\tif ( program === null ) return;\n`,
  'three renderBufferDirect skips a deferred draw'
)

patch(
  'node_modules/three/build/three.module.js',
  'if ( object.isInstancedMesh === true && object.count === 0 ) return;',
  `\t\t\tconst frontFaceCW = ( object.isMesh && object.matrixWorld.determinantAffine() < 0 );\n`,
  `\t\t\tif ( object.isInstancedMesh === true && object.count === 0 ) return;\n\n\t\t\tconst frontFaceCW = ( object.isMesh && object.matrixWorld.determinantAffine() < 0 );\n`,
  'three renderBufferDirect skips an instanced mesh with no instances before setProgram'
)

patch(
  'node_modules/bvh.js/build/index.js',
  'frustumCullingLOD(t, i, n, r, k = n.length)',
  `  frustumCullingLOD(t, i, n, r) {
    if (this.root === null) return;
    const f = this.frustum.setFromProjectionMatrix(t);
    s(this.root, 63, null);
    function s(c, u, a) {
      const y = c.box;
      if (a === null && (a = l(y)), c.object !== void 0) {`,
  `  frustumCullingLOD(t, i, n, r, k = n.length) {
    if (this.root === null) return;
    const f = this.frustum.setFromProjectionMatrix(t);
    s(this.root, 63, null);
    function s(c, u, a) {
      const y = c.box;
      if (a === null && (a = l(y)), a !== null && a >= k) return;
      if (c.object !== void 0) {`,
  'bvh.js frustumCullingLOD prunes nodes wholly inside a skipped far band'
)

patch(
  'node_modules/bvh.js/build/index.js',
  'if (u === null && (u = l(c.box)), u !== null && u >= k) return;',
  `    function o(c, u) {
      if (u === null && (u = l(c.box)), c.object !== void 0) {`,
  `    function o(c, u) {
      if (u === null && (u = l(c.box)), u !== null && u >= k) return;
      if (c.object !== void 0) {`,
  'bvh.js frustumCullingLOD showAll path prunes the skipped far band'
)

patch(
  'node_modules/@three.ez/instanced-mesh/build/index.js',
  'while (k > 1 && n[k - 1].object.visible === false) k--;',
  `    const o = this._cameraPos;
    o[0] = e.x, o[1] = e.y, o[2] = e.z, this._margin > 0 && this.accurateCulling ? this.bvh.frustumCullingLOD(t.elements, o, s, (a, c, h, u) => {
      h.isIntersectedMargin(a.box, u, this._margin) && i(a, c);
    }) : this.bvh.frustumCullingLOD(t.elements, o, s, i);`,
  `    const o = this._cameraPos;
    let k = n.length;
    while (k > 1 && n[k - 1].object.visible === false) k--;
    o[0] = e.x, o[1] = e.y, o[2] = e.z, this._margin > 0 && this.accurateCulling ? this.bvh.frustumCullingLOD(t.elements, o, s, (a, c, h, u) => {
      h.isIntersectedMargin(a.box, u, this._margin) && i(a, c);
    }, k) : this.bvh.frustumCullingLOD(t.elements, o, s, i, k);`,
  'three.ez BVH LOD cull skips trailing hidden LOD levels'
)

patch(
  'node_modules/msgpackr/pack.js',
  'value >>> 0 === value && !Object.is(value, -0)',
  `\t\t\t\tif (value >>> 0 === value) {// positive integer, 32-bit or less`,
  `\t\t\t\tif (value >>> 0 === value && !Object.is(value, -0)) {// positive integer, 32-bit or less`,
  'msgpackr -0 escapes the positive fixint branch',
  true
)

patch(
  'node_modules/msgpackr/pack.js',
  'value >> 0 === value && !Object.is(value, -0)',
  `\t\t\t\t} else if (value >> 0 === value) { // negative integer`,
  `\t\t\t\t} else if (value >> 0 === value && !Object.is(value, -0)) { // negative integer`,
  'msgpackr -0 escapes the negative fixint branch',
  true
)
