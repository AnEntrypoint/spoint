const TU = Object.freeze({
  upscale: 0,
  shadow: 1,
  transmittanceLUT: 2,
  hpf: 3,
  sceneDepth: 4,
  hpf2: 5,
  surfAlb: 6,
  surfNrm: 7,
  heightPool: 8,
  sceneTex: 9,
  scatteringLUT: 10,
  sculptOverride: 11,
});

const M4 = {
  mul(a, b, out) {
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
  translate(t, out) {
    if (!out) return new Float32Array([ 1,0,0,0, 0,1,0,0, 0,0,1,0, t[0],t[1],t[2],1 ]);
    out[0]=1; out[1]=0; out[2]=0; out[3]=0;
    out[4]=0; out[5]=1; out[6]=0; out[7]=0;
    out[8]=0; out[9]=0; out[10]=1; out[11]=0;
    out[12]=t[0]; out[13]=t[1]; out[14]=t[2]; out[15]=1;
    return out;
  },
  lookAt(eye, center, up, out) {
    const z0=eye[0]-center[0], z1=eye[1]-center[1], z2=eye[2]-center[2];
    let zl=Math.hypot(z0,z1,z2); const zx=z0/zl, zy=z1/zl, zz=z2/zl;
    let x0=up[1]*zz-up[2]*zy, x1=up[2]*zx-up[0]*zz, x2=up[0]*zy-up[1]*zx;
    let xl=Math.hypot(x0,x1,x2);
    if (xl < 1e-4) {
      const au=[0,0,1]; x0=au[1]*zz-au[2]*zy; x1=au[2]*zx-au[0]*zz; x2=au[0]*zy-au[1]*zx;
      xl=Math.hypot(x0,x1,x2);
      if (xl < 1e-4){ x0=zy*1-zz*0; x1=zz*0-zx*1; x2=zx*0-zy*0; xl=Math.hypot(x0,x1,x2); }
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
