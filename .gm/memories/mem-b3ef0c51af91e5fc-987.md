---
key: mem-b3ef0c51af91e5fc-987
ns: default
created: 1790942559689
updated: 1790942559689
---

An early return from InstancedMesh2 (@three.ez/instanced-mesh) onBeforeShadow leaves the library's onAfterShadow -> unpatchMaterial running UNPAIRED: patchMaterial saves material.customProgramCacheKey into _customProgramCacheKeyBase and installs its own; unpatchMaterial restores from _customProgramCacheKeyBase, which is null when patch never ran, so the material is left with customProgramCacheKey = null. three's WebGLPrograms.getParameters then calls material.customProgramCacheKey() and throws TypeError, the render-graph 'scene-color' node aborts on that throw and RETURNS, so every remaining node of that frame is skipped for the rest of the session. Symptom that fools measurement: frame time and CPU drop sharply and GL draw calls/frame collapse (162 -> 5) because the scene is no longer drawn -- the fix looks like a speedup while it is a black screen. Always call the base hook (or call patchMaterial yourself) so patch/unpatch stay paired; witness draw calls, not frame time.
