// Texture-unit allocation table + column-major mat4 helpers for gl-render.js's initMapspinnerRender.
// Split out as the file's only pure/stateless block -- TU is the single source of truth for GL texture
// unit assignment (see its own header comment: every historical sampler-collision bug in this file was
// a unit-assignment mistake this table exists to prevent), M4 is plain matrix math with zero GL/WebGL
// state. Neither touches GL context state or closure state from initMapspinnerRender.

// ---- texture-unit allocation (single source of truth) --------------------------------
// Units 0-9 are ONE shared GL namespace. Every historical sampler-collision bug in this file
// (uShadowMap defaulting to 0, the uHeightPool-vs-unit-0 GL_INVALID_OPERATION, the TEXTURE8 clash)
// was a unit-assignment mistake that scattered magic-number literals could not surface. This table
// is the only place a unit number is declared; adding a sampler is a table edit, not a 20-site grep.
// A field is used BOTH as gl.TEXTURE0 + TU.x (activeTexture) and as the sampler uniform's int value.
// Lifetime notes: shadow/hpf/surf/heightPool bind per terrain draw; sceneDepth/sceneTex/upscale bind
// in the water/composite/writeback tail passes; NONE may overlap within a single draw.
const TU = Object.freeze({
  upscale: 0,      // _vdrsColor/_vdrsDepth in passUpscaleToCanvas + passPlanetDepthWriteback (unit 0)
  shadow: 1,       // uShadowMap (sampler2DShadow), pinned every frame (dummy fallback when no shadow)
  transmittanceLUT: 2,  // uTransmittanceLUT (sampler2D, Bruneton-lite precomputed transmittance), pinned every frame atmosphere.glsl is in the FS (render/debug/probe programs)
  hpf: 3,          // hpfPool  (sampler2DArray, height-pool fractal band 1)
  sceneDepth: 4,   // uSceneDepth = _vdrsDepth, water/composite passes
  hpf2: 5,         // hpfPool2 (sampler2DArray, height-pool fractal band 2)
  surfAlb: 6,      // uSurfAlb (surface albedo array), main terrain draw
  surfNrm: 7,      // uSurfNrm (surface normal array), main terrain draw
  heightPool: 8,   // uHeightPool (sampler2DArray THC baked-height pool), pinned every frame
  sceneTex: 9,     // uSceneTex = _sceneCopyTex / _hrwColor, water composite
  scatteringLUT: 10,  // uScatteringLUT (sampler2DArray, Bruneton-lite precomputed single-scatter in-scattered radiance), pinned every frame atmosphere.glsl is in the FS (render/debug/probe programs) -- same discipline as transmittanceLUT above
  sculptOverride: 11,  // uSculptOverride (sampler2D R32F, GPU-visible sculpt-brush heightfield override -- terrain-gpu-visible-sculpt-mesh-deformation), pinned every frame composeHeight runs (render + probe/bake programs)
});

// ---- minimal column-major mat4 helpers (no gl-matrix dep) ----------------------------
// Every helper takes an optional trailing `out` Float32Array(16) and writes into it instead of allocating
// (returns `out`); omitted -> a fresh Float32Array exactly as before. gl-render.js's cullMatrix pools its
// six per-call matrices through these so a rebuild frame allocates nothing. mul's `out` must not alias `a`
// or `b` (the loop reads a/b while writing out).
const M4 = {
  mul(a, b, out) { // a*b, column-major (OpenGL convention)
    const o = out || new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k*4+r] * b[c*4+k];
      o[c*4+r] = s;
    }
    return o;
  },
  perspective(fovy, aspect, near, far, out) {
    const f = 1 / Math.tan(fovy/2), nf = 1/(near-far);
    if (!out) return new Float32Array([ f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0 ]);
    out[0]=f/aspect; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=f; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=(far+near)*nf; out[11]=-1;
    out[12]=0; out[13]=0; out[14]=2*far*near*nf; out[15]=0;
    return out;
  },
  // column-major translation matrix translate(t): maps p -> p + t
  translate(t, out) {
    if (!out) return new Float32Array([ 1,0,0,0, 0,1,0,0, 0,0,1,0, t[0],t[1],t[2],1 ]);
    out[0]=1; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=1; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=1; out[11]=0;
    out[12]=t[0]; out[13]=t[1]; out[14]=t[2]; out[15]=1;
    return out;
  },
  // lookAt view matrix (world->camera), column-major
  lookAt(eye, center, up, out) {
    const z0=eye[0]-center[0], z1=eye[1]-center[1], z2=eye[2]-center[2];
    let zl=Math.hypot(z0,z1,z2); const zx=z0/zl, zy=z1/zl, zz=z2/zl;
    let x0=up[1]*zz-up[2]*zy, x1=up[2]*zx-up[0]*zz, x2=up[0]*zy-up[1]*zx;
    let xl=Math.hypot(x0,x1,x2);
    if (xl < 1e-4) {                 // up parallel to view dir (poles) -> pick another up
      const au=[0,0,1]; x0=au[1]*zz-au[2]*zy; x1=au[2]*zx-au[0]*zz; x2=au[0]*zy-au[1]*zx;
      xl=Math.hypot(x0,x1,x2);
      if (xl < 1e-4){ x0=zy*1-zz*0; x1=zz*0-zx*1; x2=zx*0-zy*0; xl=Math.hypot(x0,x1,x2); } // up=[1,0,0]
    }
    xl = xl || 1; x0/=xl; x1/=xl; x2/=xl;
    const y0=zy*x2-zz*x1, y1=zz*x0-zx*x2, y2=zx*x1-zy*x0;
    const o = out || new Float32Array(16);
    o[0]=x0; o[1]=y0; o[2]=zx; o[3]=0;
    o[4]=x1; o[5]=y1; o[6]=zy; o[7]=0;
    o[8]=x2; o[9]=y2; o[10]=zz; o[11]=0;
    o[12]=-(x0*eye[0]+x1*eye[1]+x2*eye[2]); o[13]=-(y0*eye[0]+y1*eye[1]+y2*eye[2]); o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]); o[15]=1;
    return o;
  },
};

export { TU, M4 };
