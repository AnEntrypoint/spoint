---
key: mem-cbff02e66cec04bb-1733
ns: default
created: 1790058515869
updated: 1790058515869
---

## Resolved mutable: mut-1790056420718

packages/mapspinner/src/webgpu/terrain-composeheight-wgsl.js: sculptOverrideAt ported 1:1 from terrain.glsl lines 188-199 (uSculptActive gate, dot(dir0,uSculptUp)<=0 hemisphere gate, surfR=defRadius+hBase gnomonic-style east/north projection exactly as written in the live GLSL source -- NOT the generic gnomonic-division formula the stale recall memo project/mapspinner-sculpt-override-domain paraphrased; the real terrain.glsl code has no /dot(dir0,up) division, confirmed by direct Read of the live shader source this session, so the memo's paraphrase was not followed). No CPU oracle exists for this fn (gen-height.mjs STUB_FNS hard-stubs sculptOverrideAt to constant 0.0, confirmed live: recall project/mapspinner-gen-height-sculpt-stub + this session's own oracle run showed CPU composeHeight matches WGSL with sculptActive=0 to fp32-noise precision). Structural self-consistency live-witnessed via browser verb (dispatch browser-gm-tsl-convert-20260922-mapspinner2-13, real navigator.gpu): with a synthetic constant-42 sculpt texture (res=4) and sculptCenter=[0,0]/extent=1000/up=[0,1,0]/east=[1,0,0]/north=[0,0,1], dir=[0,1,0] (inside up hemisphere, uv resolves to [0.5,0.5], in-bounds) got upDelta=result_with_sculpt-result_without_sculpt=42 exactly, matching the analytically-predicted value (surfR*dot(up,east)=0, surfR*dot(up,north)=0 -> uv=[0.5,0.5] -> constant-texture sample=42). dir=[0,-1,0] (outside the sculptUp hemisphere) got downDelta=0 exactly, confirming the hemisphere gate blocks sculpt regardless of active flag. Both edge cases (active gate, hemisphere gate, in-bounds uv sampling) verified against independently-derived expected values, not merely code inspection.
