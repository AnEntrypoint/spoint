cd /workspace/spoint
echo "## restored: window.__spoint._drive"; grep -n "_drive: drive" client/core/Relocation.js | cut -c1-120
echo "## restored: fireKernel.js burnCell"; grep -n "function burnCell" src/shared/fire/fireKernel.js
echo "## restored: BaseClient.js sendInput / predEngine.addInput / predictionLeadSteps / MAX_PREDICTION_LEAD_STEPS"; grep -n "MAX_PREDICTION_LEAD_STEPS" src/client/BaseClient.js | cut -c1-140
echo "## restored: three.webgpu.js popErrorScope x3 patched"; grep -c "node_modules/three/build/three.webgpu.js" scripts/patch-deps.mjs; grep -c "popErrorScope" scripts/patch-deps-marker-witness.mjs
echo "## restored: ClusterLodMesh._render early return"; grep -n "_lastRenderFrame === frame" packages/streaming-gltf/src/cluster-lod-mesh.js
echo "## restored: window.__vdrs === true"; grep -n "window.__vdrs === true" packages/mapspinner/src/gl-render.js | cut -c1-120; git grep -c "vdrs" -- packages/mapspinner/src/tsl || echo "tsl: 0 vdrs matches"
echo "## restored: registry.set (perf-run knob script)"; grep -n "registry.set(k.key" scripts/perf-run.mjs | cut -c1-120
echo "## restored: installRenderControls()"; grep -n "installRenderControls()" client/app.js | cut -c1-120
echo "## retired: splitCoalesced"; grep -n "function splitCoalesced" scripts/verify-session.mjs; git grep -n "splitCoalesced" -- src client | wc -l
echo "## retired: outputNode in planet.html"; grep -c "outputNode" packages/mapspinner/planet.html; grep -n "__fsCheap" packages/mapspinner/planet.html | head -n 1 | cut -c1-120
echo "## retired: side = DoubleSide"; grep -n "DoubleSide" packages/mapspinner/src/tsl/terrain-material-tsl.js | wc -l; grep -n "material.side" packages/mapspinner/src/tsl/terrain-material-tsl.js | cut -c1-120
echo "## retired: INIT.worldName"; grep -n "worldName: selectedWorldName" src/sdk/WorkerEntry.js | cut -c1-120; git grep -c "INIT.worldName" -- src client | wc -l
echo "## retired: frame-time-gate lines"; grep -n "UNLOCK_RAF =\|UNLOCKED_RAF_ARGS =" scripts/frame-time-gate.mjs | cut -c1-120
echo "## retired: legacygl gate line"; grep -n "_legacyGlRequested = " client/app.js | cut -c1-120
echo "## retired: TerrainBackdrop import branches"; grep -n "await import(" client/core/TerrainBackdrop.js | cut -c1-120
echo "## retired: terrain-reseed-failure-witness.mjs"; ls scripts/terrain-reseed-failure-witness.mjs 2>&1 | head -n 1; git grep -l "terrain-reseed-failure-witness" -- . | wc -l
