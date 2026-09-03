# mapspinner — WebGL2 Earth-scale Terrain SDK

A performant, production-ready WebGL2 rendering SDK for interactive Earth-scale globe applications. Designed as a composable rendering layer that integrates seamlessly into projects like spoint.

## Quick Start

```bash
npm install mapspinner
```

```javascript
import { createPlanet } from 'mapspinner';

// In your WebGL2 application
const planet = await createPlanet(gl, {
  radius: 6360000,      // Earth radius in meters
  gridMeshSize: 16      // Mesh subdivision level
});

// Per-frame render
planet.frame();
```

## Integration Example

For integration into external projects (e.g., spoint), see `examples/basic-sdk-usage.html` for a complete setup including peer dependencies, camera control, and WebGL context initialization.

## Development

```bash
PORT=8080 npm run dev
# open http://localhost:8080/ in any WebGL2 browser
```

## Controls

- **WASD** / mouse drag — yaw + pitch
- **Q / E** / mouse wheel — zoom in / out
- **R** — reset camera

The camera flies continuously from orbit to first-person on the surface; the terrain LOD
refines as you descend.

## Architecture

The terrain is a single continuous world-direction fractal evaluated per-vertex on the GPU — a lean, portable design with no procedural tile generation or offline preprocessing.

- **`src/shaders/terrain.glsl`** — the core fractal. Height per vertex =
  `cbias` (continental elevation bias) + `broadShapeM` (silhouette + relief) + `vtxDisplace` (micro-relief) + carves. The fragment stage shades via biome ramp + seamless normal + ocean/lake/river.
- **`src/quadtree.js`** — cube-sphere quadtree LOD in JS. Selects visible patches based on camera altitude.
- **`src/planet-orchestrator.js`** — per-frame quadtree drive, mesh generation, and render dispatch.
- **`src/anchor-field.js`** — world-direction climate/elevation modulation (biome, temperature).
- **`src/gl-render.js`** — WebGL2 program compile, mesh generation, per-quad draw.
- **`src/index.js`** — SDK entry point for external consumers.

## Layout

```
planet.html                  dev demo entry + __diag witness harness
server.js                    dev static server (COOP/COEP, no-cache)
src/shaders/terrain.glsl     terrain fractal (VS + FS)
src/shaders/atmosphere.glsl  analytic sky/limb shading
src/quadtree.js              cube-sphere quadtree LOD
src/planet-orchestrator.js   per-frame drive + render dispatch
src/anchor-field.js          elevation anchor field
src/gl-render.js             WebGL2 render layer
src/index.js                 SDK entry point
examples/                    integration examples
tests/                       SDK validation tests
```

## Testing

```bash
npm test
```

Tests validate SDK geometry output, shader compilation, and rendering invariants.

## License

MIT
