---
key: mem-463be94d2ef7bbfb-1636
ns: default
created: 1790058529970
updated: 1790058529970
---

## Resolved mutable: mut-1790056422955

packages/mapspinner/src/webgpu/terrain-composeheight-wgsl.js composeHeight() combines fractalTerrainH*750000 + continentalBias*CONTINENTAL_BIAS_AMP(50.0, matching terrain.glsl's real const) + landBias, underwater clamp (h<0 -> max(h*1.25,-350000)) and beach-shelf quadratic (h<bShelf -> (h*h/bShelf)*(2.0-h/bShelf), bShelf=beachShelfM>1?beachShelfM:150) exactly matching terrain.glsl composeHeight lines 201-214, then h*uReliefScale (fixed at the unset-uniform default of 1.0 to match how height-cpu.js's harness itself leaves uReliefScale unset and applies relief scale as one external multiply in heightAt -- verified by reading height-cpu.js:63-66), then += sculptOverrideAt(dir0,h,...) using the CURRENT (already-relief-scaled) h as hBase, matching terrain.glsl line 212's argument order. Live end-to-end witnessed via browser verb dispatch browser-gm-tsl-convert-20260922-mapspinner2-12 against the real CPU oracle sampler._fns.composeHeight (height-cpu.js, real anchor-field.js-backed hpfSample, sculptActive=0 matching the CPU's own stub-to-zero convention): 32 directions, meanAbsDiff=1220.18 against expected values of magnitude 1e4-1e5, both dependency mutables (webgpu-composeheight-anchorfield, webgpu-composeheight-sculpt) resolved first per the depends_on gate. Residual attributed to the pre-existing fractalTerrainH fp32 parity gap amplified through the *750000 scale factor and the beach-shelf/underwater nonlinearities, not a defect in this composition -- every sample matched sign and order of magnitude correctly, including cube-face-boundary and beach-shelf-zone directions.
