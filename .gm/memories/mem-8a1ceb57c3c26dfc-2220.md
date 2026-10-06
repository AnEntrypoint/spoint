---
key: mem-8a1ceb57c3c26dfc-2220
ns: default
created: 1791244907354
updated: 1791244907354
---

project/draw-figure-ownership-instrument-mapping: four mutually inconsistent draws-per-frame
figures in this project are four different instruments, not four measurements of one thing.
AUTHORITATIVE = scripts/perf-run.mjs `drawsInstrument.authoritativeField`: `wgpuDrawsPerFrame`
on WebGPU, `glDrawCallsPerFrame` on legacyGL. One unit = one draw submitted to the driver,
measured as a per-frame DELTA of the rig's own monotonic counter, so it can neither be a
lifetime ramp nor a last-render slice. (1) 141 = that instrument: D-metric-v1 wgpuDraws
avg 140.8 / p95 148 / max 150; V-vegvar3 137.7 / 140 / 141. (2) 19336 = three's
`info.render.calls` on the WebGPU (renderers/common) renderer: incremented once per
_renderScene in renderers/common/Renderer.js and NOT cleared by Info.reset (only dispose),
so it is a lifetime scene-render counter. Ramp signature in the arms' own data: W-v1j
avg/max=0.5126 p95/max=0.948 max/frames=3.813 and W-v1k 0.515 / 0.948 / 3.84 -- a linear
ramp has mean 0.5*max and p95 0.95*max. VOID, never a draw count. (3) 4.2 = three's
`info.render.drawCalls` sampled by the rig's own rAF callback, which is registered at
document start and therefore runs BEFORE three's Animation callback calls info.reset --
it reads the tail of the previous frame. D-metric-v1 draws avg 4.2 / p95 2 / max 378.
4.2-105 is the same field read at different phases. (4) 450 has no run on file in
data/perf-run and no memo recording it; it predates the wgpu hook and the veg cull
changes. RETIRED, not re-expressed. Correction to the PRD bodies: spoint does NOT drive
its own rAF loop -- client/app.js calls renderer.setAnimationLoop(animate), so
Animation.js DOES call info.reset() once per frame; the defect is only that reset() never
clears render.calls. Fixed (2026-10-06): perf-run accumulates three-side drawCalls and
triangles across every info.reset() in the frame instead of sampling the field, and
reports rendererRenderCallsPerFrame separately as scene renders (NOT draws). Caveat:
the GL instantiation wraps every WebGL context on the page, so it can count a non-three
context's draws -- on legacyGL it reads 158-197 against three's 110-116, ratio 1.4-1.8;
compare instruments within one backend only.
