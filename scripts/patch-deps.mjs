import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const PINNED_VERSIONS = {
  '@three.ez/instanced-mesh': '0.3.16'
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

function patch(relPath, marker, anchor, replacement, label) {
  const file = new URL('../' + relPath, import.meta.url)
  if (!existsSync(file)) { console.log(`[patch-deps] ${label}: not installed; skipping`); return }
  const pkgMatch = relPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  if (pkgMatch) checkPinnedVersion(pkgMatch[1])
  const src = readFileSync(file, 'utf8')
  if (src.includes(marker)) { console.log(`[patch-deps] ${label}: already present (published or patched); no-op`); return }
  if (!src.includes(anchor)) { console.warn(`[patch-deps] ${label}: anchor not found -- upstream shape changed; skipping (verify the fix manually)`); return }
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
