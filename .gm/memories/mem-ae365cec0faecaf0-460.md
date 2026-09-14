---
key: mem-ae365cec0faecaf0-460
ns: default
created: 1789391464290
updated: 1789391464290
---

project/csm-shaderchunk-patch-placement: client/core/CascadeShadowSelect.js must append spointCascadeWeight() to THREE.ShaderChunk.shadowmap_pars_fragment (top-level, before main()), never lights_fragment_begin (included inside main() -> nested function decl = GLSL syntax error, live-caught). The spointCamDist local must be declared once ABOVE #pragma unroll_loop_start: unrollLoops concatenates bodies without braces, so a loop-body local is a redefinition.
