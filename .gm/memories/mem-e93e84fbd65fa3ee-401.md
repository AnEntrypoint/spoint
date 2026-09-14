---
key: mem-e93e84fbd65fa3ee-401
ns: default
created: 1789392296206
updated: 1789392296206
---

project/sph-seed-lattice-must-fit-boundary: apps/_lib/fluid.js and fluid3d.js _seed shrink lattice spacing (maxSpacingForFit, 0.9 inset) so every particle lands inside the solver box: SPHSolver addParticle has no bounds check, and out-of-box seeds went NaN within ~20 steps (32/300 in fluid-source's default box). SOLVER_MAX_PARTICLES=4096 must match MAX_PARTICLES in src/fluid/as-src/sph.ts/sph3d.ts.
