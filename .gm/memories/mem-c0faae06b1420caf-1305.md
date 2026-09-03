---
key: mem-c0faae06b1420caf-1305
ns: default
created: 1787533139824
updated: 1787533139824
---

Ground/depth-map occlusion growing with camera altitude root-caused and fixed 2026-08-24 in packages/mapspinner/src/gl-render.js: the straight-to-canvas render path (default app config) never ran the depth-writeback re-encode passPlanetDepthWriteback()/dwProg -- that only ran on the VDRS/half-res-water FBO path. mapspinner's own near plane scales with altitude (near=altAboveTerrain*0.1, 0.5 at deck to 15.37 at +150m) while the host's THREE camera near stays fixed at 0.3 (RenderGraph.nodes.js host-near-far node, a prior deliberate fix for a different bug). The un-re-encoded depth mismatch grew with altitude, occluding real scene geometry (trees/player/models) progressively worse the higher the camera went. Live-eliminated window.__planetDepthToCanvas toggle (zero effect, proved writeback was dead code at this config). Fix: added _hostNearFarMismatch detection ORd into the _vdrsOn gate, routing straight-to-canvas through the same writeback machinery whenever host/mapspinner near-far diverge. Live-verified via a 70m ground-anchored test column read back through rAF-timed WebGL readPixels (not canvas.toDataURL, which manufactures a false black-void per this project's own known trap): 0/20 visible pre-fix at +80/+150m altitude, 20/20 post-fix at every altitude tested. Committed 8c63451735.
