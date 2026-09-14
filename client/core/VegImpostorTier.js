import * as THREE from 'three'
import { InstancedMesh2 } from '@three.ez/instanced-mesh'
import { createOctahedralImpostorMaterial } from 'streaming-gltf/octahedral-impostor-ez'
import { dbg } from './debug-log.js'

const _dbgImpostor = dbg('impostor')

export const IMPOSTOR_DISSOLVE_FADE_BAND_M = 3.0

export function buildSharedImpostorAtlas(renderer, speciesAtlases, opts = {}) {
  const list = (speciesAtlases || []).filter(a => a && a.albedo)
  const n = list.length
  if (!renderer || n === 0) return null
  const atlasSize = opts.atlasSize || (list[0].albedo.image ? (list[0].albedo.image.width || 1024) : 1024)
  const gridSide = Math.max(1, Math.ceil(Math.sqrt(n)))
  const mega = atlasSize * gridSide
  const hasNormal = list.every(a => a.normal)

  const mkRT = () => {
    const rt = new THREE.WebGLRenderTarget(mega, mega, {
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, generateMipmaps: true,
    })
    rt.texture.anisotropy = 4
    try { renderer.initRenderTarget(rt) } catch (_) {}
    return rt
  }
  const albedoRT = mkRT()
  const normalRT = hasNormal ? mkRT() : null

  const _dst = new THREE.Vector2()
  const tiles = []
  let copied = 0
  const disposeSource = opts.disposeSource !== false
  for (let i = 0; i < n; i++) {
    const col = i % gridSide, row = Math.floor(i / gridSide)
    _dst.set(col * atlasSize, row * atlasSize)
    try {
      renderer.copyTextureToTexture(list[i].albedo, albedoRT.texture, null, _dst)
      if (normalRT && list[i].normal) renderer.copyTextureToTexture(list[i].normal, normalRT.texture, null, _dst)
      copied++
    } catch (e) { console.warn('[vegImpostorTier] tile copy failed:', i, e?.message || e) }
    if (disposeSource) {
      try { list[i].albedo && list[i].albedo.dispose && list[i].albedo.dispose() } catch (e) { _dbgImpostor('source albedo dispose failed:', i, e?.message || e) }
      try { list[i].normal && list[i].normal.dispose && list[i].normal.dispose() } catch (e) { _dbgImpostor('source normal dispose failed:', i, e?.message || e) }
    }
    tiles.push({ species: i, col, row, offset: [col / gridSide, row / gridSide] })
  }

  const _regenMips = (rt) => {
    if (!rt) return
    try {
      const gl = renderer.getContext()
      const props = renderer.properties.get(rt.texture)
      const tex = props && props.__webglTexture
      if (gl && tex) { gl.bindTexture(gl.TEXTURE_2D, tex); gl.generateMipmap(gl.TEXTURE_2D) }
    } catch (e) { console.warn('[vegImpostorTier] mip regen failed (level-0 only):', e?.message || e) }
  }
  _regenMips(albedoRT)
  _regenMips(normalRT)

  const result = {
    albedo: albedoRT.texture, normal: normalRT ? normalRT.texture : null,
    albedoRT, normalRT, tileScale: 1 / gridSide, gridSide, atlasSize, mega, tiles, copied,
    dispose() { try { albedoRT.dispose() } catch (e) { _dbgImpostor('albedoRT dispose failed:', e?.message || e) } try { normalRT && normalRT.dispose() } catch (e) { _dbgImpostor('normalRT dispose failed:', e?.message || e) } },
    megaBytes: mega * mega * 4 * (normalRT ? 2 : 1),
    perSpeciesBytes: n * atlasSize * atlasSize * 4 * (hasNormal ? 2 : 1),
  }
  if (typeof window !== 'undefined') window.__vegImpostorAtlas = result
  return result
}

export function createSharedImpostorMesh(renderer, atlas, dims, opts = {}) {
  if (!renderer || !atlas) return null
  const capacity = Math.min(opts.maxInstances || 20000, opts.initCapacity || 4096)
  const mat = createOctahedralImpostorMaterial({
    albedo: atlas.albedo, normalDepth: atlas.normal,
    useHemiOctahedron: false, spritesPerSide: opts.spritesPerSide || 8,
    transparent: false, alphaClamp: opts.alphaClamp ?? 0.4,
    transform: new THREE.Matrix4(),
    atlasTile: true, atlasGridSide: atlas.gridSide, renderer,
    farSingleSprite: opts.farSingleSprite !== false,
    parallax: opts.parallax === true, parallaxScale: opts.parallaxScale ?? 0.3,
  })
  mat.polygonOffset = true
  mat.polygonOffsetFactor = -4
  mat.polygonOffsetUnits = -8
  const nearCutoff = opts.nearCutoff
  const hasNearLodCutoff = Number.isFinite(nearCutoff) && nearCutoff > 0
  if (hasNearLodCutoff) {
    const baseCompile = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, r) => {
      baseCompile?.call(mat, shader, r)
      shader.uniforms.uImpNearCutoff = { value: nearCutoff }
      shader.vertexShader = 'uniform float uImpNearCutoff;\nvarying float vImpCamDist;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvImpCamDist = distance(cameraPosition, (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz);')
      shader.fragmentShader = 'uniform float uImpNearCutoff;\nvarying float vImpCamDist;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n' +
        `float _impFade = clamp((vImpCamDist - (uImpNearCutoff - ${IMPOSTOR_DISSOLVE_FADE_BAND_M.toFixed(1)})) / ${IMPOSTOR_DISSOLVE_FADE_BAND_M.toFixed(1)}, 0.0, 1.0);\n` +
        'float _impDither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));\n' +
        'if (_impDither > _impFade) discard;')
    }
    const baseKey = mat.customProgramCacheKey
    mat.customProgramCacheKey = () => baseKey() + '_impfade'
  }
  let baseGeo
  if (hasNearLodCutoff) {
    baseGeo = new THREE.BufferGeometry()
    baseGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3))
    baseGeo.setIndex([0, 1, 2])
  } else {
    baseGeo = new THREE.PlaneGeometry(1, 1)
  }
  const _stampUnitCullVolume = (g) => {
    g.computeBoundingSphere(); if (!g.boundingSphere) g.boundingSphere = new THREE.Sphere()
    g.boundingSphere.center.set(0, 0, 0); g.boundingSphere.radius = 1.0
    if (!g.boundingBox) g.boundingBox = new THREE.Box3()
    g.boundingBox.min.set(-1, -1, -1); g.boundingBox.max.set(1, 1, 1)
    return g
  }
  _stampUnitCullVolume(baseGeo)
  const im = new InstancedMesh2(baseGeo, mat, { capacity, renderer })
  im.initUniformsPerInstance({ fragment: { atlasTile: 'float' } })
  im.perObjectFrustumCulled = true
  im.frustumCulled = false
  if (hasNearLodCutoff) {
    const hys = Number.isFinite(opts.lodHysteresis) ? opts.lodHysteresis : 0.12
    try { im.addLOD(_stampUnitCullVolume(new THREE.PlaneGeometry(1, 1)), mat, nearCutoff, hys) } catch (_) {}
  }
  const _c = new THREE.Vector3()
  function addImpostor(species, baseX, baseY, baseZ) {
    const d = dims[species] || { center: [0, 1, 0], radius: 1 }
    const sz = d.radius * 2
    let id = -1
    im.addInstances(1, (e) => {
      e.position.set(baseX + d.center[0], baseY + d.center[1], baseZ + d.center[2])
      e.scale.setScalar(sz); id = e.id
    })
    try { im.setUniformAt(id, 'atlasTile', species) } catch (_) {}
    return id
  }
  function addImpostors(cands) {
    const n = cands.length
    if (n === 0) return []
    const ids = new Array(n)
    let bi = 0
    im.addInstances(n, (e) => {
      const c = cands[bi]
      const d = dims[c.species] || { center: [0, 1, 0], radius: 1 }
      const sz = d.radius * 2
      e.position.set(c.x + d.center[0], c.y + d.center[1], c.z + d.center[2])
      e.scale.setScalar(sz)
      ids[bi] = e.id
      bi++
    })
    for (let i = 0; i < n; i++) { try { im.setUniformAt(ids[i], 'atlasTile', cands[i].species) } catch (_) {} }
    return ids
  }
  function removeImpostor(id) { try { im.removeInstances(id) } catch (_) {} }
  return { mesh: im, material: mat, addImpostor, addImpostors, removeImpostor, get count() { return im.instancesCount || 0 } }
}

export function probeAtlasTile(renderer, atlas, speciesIndex) {
  if (!renderer || !atlas) return -1
  const t = atlas.tiles[speciesIndex]; if (!t) return -1
  const cx = t.col * atlas.atlasSize + (atlas.atlasSize >> 1)
  const cy = t.row * atlas.atlasSize + (atlas.atlasSize >> 1)
  const buf = new Uint8Array(8 * 8 * 4)
  try { renderer.readRenderTargetPixels(atlas.albedoRT, cx - 4, cy - 4, 8, 8, buf) } catch (_) { return -1 }
  let nonZero = 0
  for (let i = 0; i < buf.length; i += 4) { if (buf[i] || buf[i + 1] || buf[i + 2] || buf[i + 3]) nonZero++ }
  return nonZero
}
