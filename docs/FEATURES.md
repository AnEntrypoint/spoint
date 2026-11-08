# spoint features: netcode, protocol, client, sharding, static, animation

Scope: src/netcode, src/protocol, src/client, src/sharding, src/static, src/animation (rows 1-103) and packages/mapspinner (all of src/ and the top-level planet files, rows 104-176). Other source areas are not listed here yet.

Status rules: PROVEN means a tracked scripts/ witness references the feature's symbol and prints its own RESULT line from assertions. UNPROVEN means no such witness: either none references it, or the only reference is a path inventory (scripts/cross-map-parity.mjs), or the referencing script prints no RESULT line. HELD means an owner decision is pending.

Proof paths are repo-relative tracked files. A dash means no proof path.

| # | Feature | Source | Proof | Status |
|---|---|---|---|---|
| 1 | Lockstep game loop refuses inputDelayTicks above INPUT_RETAIN_TICKS | src/netcode/LockstepGameLoop.js | - | UNPROVEN |
| 2 | Lockstep game loop factory | src/netcode/LockstepGameLoop.js | - | UNPROVEN |
| 3 | Lockstep tick system | src/netcode/LockstepTickSystem.js | - | UNPROVEN |
| 4 | Lockstep input transport | src/netcode/LockstepInputTransport.js | - | UNPROVEN |
| 5 | Rollback game loop stalls past maxRollbackTicks | src/netcode/RollbackGameLoop.js | scripts/peer-profile-harness.mjs | UNPROVEN |
| 6 | Rollback loop | src/netcode/RollbackLoop.js | - | UNPROVEN |
| 7 | Rollback input transport | src/netcode/RollbackInputTransport.js | - | UNPROVEN |
| 8 | Tick system and tick-drop counter | src/netcode/TickSystem.js | scripts/tick-drop-counter-witness.mjs | PROVEN |
| 9 | Tick system base | src/netcode/TickSystemBase.js | - | UNPROVEN |
| 10 | Lockstep checksum fold and body checksum | src/netcode/LockstepChecksum.js | scripts/netcode-wire-pbt.mjs | PROVEN |
| 11 | Desync detection | src/netcode/DesyncDetector.js | - | UNPROVEN |
| 12 | Consensus voter for desync | src/netcode/ConsensusVoter.js | - | UNPROVEN |
| 13 | Cheat ejection | src/netcode/CheatEjection.js | - | UNPROVEN |
| 14 | Input guard: rate limit, payload sanitize, movement envelope | src/netcode/InputGuard.js | - | UNPROVEN |
| 15 | Lag compensation with clamped rewind | src/netcode/LagCompensator.js | scripts/lag-overflow-witness.mjs | PROVEN |
| 16 | Rewind spatial index with duplicate player id refusal | src/netcode/RewindSpatialIndex.js | - | UNPROVEN |
| 17 | Hitscan fire request resolution | src/netcode/Hitscan.js | scripts/planet-multiplayer-harness.mjs | PROVEN |
| 18 | Hitscan ray versus capsule | src/netcode/Hitscan.js | - | UNPROVEN |
| 19 | Outlier detector | src/netcode/OutlierDetector.js | - | UNPROVEN |
| 20 | Replay recorder | src/netcode/ReplayRecorder.js | scripts/replay-record-and-play.mjs | UNPROVEN |
| 21 | Replay player | src/netcode/ReplayPlayer.js | scripts/replay-record-and-play.mjs | UNPROVEN |
| 22 | Replay file encode and decode (SPOINTREPLAY) | src/netcode/ReplayFile.js | scripts/replay-record-and-play.mjs | UNPROVEN |
| 23 | Event log | src/netcode/EventLog.js | - | UNPROVEN |
| 24 | Snapshot encoder with per-recipient self block and tombstones | src/netcode/SnapshotEncoder.js | scripts/planet-multiplayer-harness.mjs | PROVEN |
| 25 | Player LOD tiers (full and reduced) | src/netcode/SnapshotEncoder.js | scripts/planet-multiplayer-harness.mjs | PROVEN |
| 26 | Binary snapshot records (full and reduced pose) | src/netcode/SnapshotBinFormat.js | scripts/netcode-wire-pbt.mjs | PROVEN |
| 27 | Snapshot packer | src/netcode/SnapshotPacker.js | - | UNPROVEN |
| 28 | Teleport hold | src/netcode/TeleportHold.js | - | UNPROVEN |
| 29 | Peer simulation session | src/netcode/PeerSimSession.js | scripts/peer-profile-harness.mjs | UNPROVEN |
| 30 | Peer loop factories and simulated profiles | src/netcode/peerLoops.js | - | UNPROVEN |
| 31 | Netcode profiles (resolveNetcodeProfile) | src/netcode/NetcodeProfile.js | - | UNPROVEN |
| 32 | Control frame codec (lockstep, rollback and consensus prefixes) | src/netcode/controlFrame.js | scripts/netcode-wire-pbt.mjs | PROVEN |
| 33 | Worker bridge proxy | src/netcode/WorkerBridgeProxy.js | - | UNPROVEN |
| 34 | Player-to-player collision push | src/netcode/CollisionSystem.js | - | UNPROVEN |
| 35 | Collision tile streamer | src/netcode/CollisionTileStreamer.js | - | UNPROVEN |
| 36 | Player manager | src/netcode/PlayerManager.js | scripts/src-batch3-rules-witness.mjs | PROVEN |
| 37 | Physics integration | src/netcode/PhysicsIntegration.js | - | UNPROVEN |
| 38 | Network state | src/netcode/NetworkState.js | - | UNPROVEN |
| 39 | Message type table and name lookup (msgName, isRegisteredMessage) | src/protocol/MessageTypes.js | scripts/src-batch1-rules-witness.mjs | PROVEN |
| 40 | Unreliable message classification (isUnreliable) | src/protocol/MessageTypes.js | scripts/src-batch1-rules-witness.mjs | PROVEN |
| 41 | Wire protocol version and disconnect reasons | src/protocol/MessageTypes.js | - | UNPROVEN |
| 42 | Input packet encode keeps newest records and reports drops | src/protocol/InputCodec.js | - | UNPROVEN |
| 43 | Input quantization clamps pitch and wraps yaw | src/protocol/InputCodec.js | - | UNPROVEN |
| 44 | Input packet decode | src/protocol/InputCodec.js | - | UNPROVEN |
| 45 | Msgpack pack, unpack and lazy packer (ensurePacked) | src/protocol/msgpack.js | scripts/verify-session.mjs | PROVEN |
| 46 | Wire structure hash and WIRE_STRUCTURES order | src/protocol/msgpack.js | - | UNPROVEN |
| 47 | Component schema validation and custom field codec | src/protocol/ComponentSchema.js | - | UNPROVEN |
| 48 | Cursor event stream with reconnect backoff | src/protocol/CursorEventStream.js | - | UNPROVEN |
| 49 | Event emitter with unsubscribe | src/protocol/EventEmitter.js | scripts/tick-drop-counter-witness.mjs | PROVEN |
| 50 | Base client prediction lead bound (MAX_PREDICTION_LEAD_STEPS) | src/client/BaseClient.js | - | UNPROVEN |
| 51 | Coalesced frame split (splitCoalesced) | src/client/BaseClient.js | scripts/verify-session.mjs | PROVEN |
| 52 | Transport connect rejects with TransportConnectError | src/client/PhysicsNetworkClient.js | - | UNPROVEN |
| 53 | Physics network client connection | src/client/PhysicsNetworkClient.js | scripts/planet-multiplayer-harness.mjs | PROVEN |
| 54 | Reconnect manager | src/client/ReconnectManager.js | - | UNPROVEN |
| 55 | Transport migration trigger | src/client/TransportMigrationTrigger.js | - | UNPROVEN |
| 56 | Clock sync | src/client/ClockSync.js | - | UNPROVEN |
| 57 | Chart epoch sync with held-snapshot resync request | src/client/ChartEpochSync.js | - | UNPROVEN |
| 58 | Client prediction engine | src/client/PredictionEngine.js | - | UNPROVEN |
| 59 | Prediction blocked-direction suppression (wedgeNormal) | src/client/PredictionEngine.js | - | UNPROVEN |
| 60 | Reconciliation engine | src/client/ReconciliationEngine.js | - | UNPROVEN |
| 61 | Snapshot timeline interpolation | src/client/SnapshotTimeline.js | - | UNPROVEN |
| 62 | Snapshot processor | src/client/SnapshotProcessor.js | - | UNPROVEN |
| 63 | Quaternion slerp | src/client/interpolation.js | - | UNPROVEN |
| 64 | Player and entity record reexpression | src/client/reexpressRecords.js | - | UNPROVEN |
| 65 | Prediction chart step normal and motion reexpression | src/client/PredictionChart.js | - | UNPROVEN |
| 66 | Step trail | src/client/StepTrail.js | - | UNPROVEN |
| 67 | Collision mirror | src/client/CollisionMirror.js | - | UNPROVEN |
| 68 | Input handler and keybind conflict detection | src/client/InputHandler.js | - | UNPROVEN |
| 69 | Input action compile (keyboard and touch) | src/client/InputActions.js | - | UNPROVEN |
| 70 | Input stepper | src/client/InputStepper.js | - | UNPROVEN |
| 71 | Touch surface resolver | src/client/touchSurfaces.js | scripts/touch-surface-resolver-witness.mjs | PROVEN |
| 72 | Audio mixer and defineAudio | src/client/AudioMixer.js | - | UNPROVEN |
| 73 | Client message handler | src/client/MessageHandler.js | - | UNPROVEN |
| 74 | Cluster manager | src/sharding/ClusterManager.js | scripts/cluster-world-harness.mjs | PROVEN |
| 75 | Cluster runtime | src/sharding/ClusterRuntime.js | scripts/cluster-world-harness.mjs | PROVEN |
| 76 | Cluster world host capacity refusal (ClusterWorldCapacityError) | src/sharding/ClusterWorldHost.js | scripts/cluster-world-harness.mjs | PROVEN |
| 77 | Cluster coordinator | src/sharding/ClusterCoordinator.js | - | UNPROVEN |
| 78 | Player handoff export | src/sharding/ClusterHandoff.js | scripts/cluster-world-harness.mjs | PROVEN |
| 79 | Cluster chart-local spawn | src/sharding/ClusterServerWorld.js | scripts/cluster-world-harness.mjs | PROVEN |
| 80 | Region grid ids and ghost-margin bounds | src/sharding/RegionGrid.js | - | UNPROVEN |
| 81 | Region IPC transport | src/sharding/RegionIPCTransport.js | - | UNPROVEN |
| 82 | Region router and handoff | src/sharding/RegionRouter.js | - | UNPROVEN |
| 83 | Sharding refusal table | src/sharding/ShardingRefusal.js | - | UNPROVEN |
| 84 | Region worker entry | src/sharding/RegionWorkerEntry.js | - | UNPROVEN |
| 85 | GLB transform cache | src/static/GLBTransformer.js | - | UNPROVEN |
| 86 | Draco strip and Meshopt compression | src/static/GLBDraco.js | - | UNPROVEN |
| 87 | KTX2 conversion and apply | src/static/GLBKtx2.js | - | UNPROVEN |
| 88 | VRM0 and VRMC passthrough | src/static/GLBVrmPassthrough.js | - | UNPROVEN |
| 89 | KTX2 image extraction and cache | src/static/KTX2Extract.js | - | UNPROVEN |
| 90 | Progressive bake and contained-path check | src/static/ProgressiveBake.js | - | UNPROVEN |
| 91 | Fetch manifest | src/static/FetchManifest.js | - | UNPROVEN |
| 92 | Bake code version pins | src/static/BakeCodeVersion.js | scripts/check-cache-keys.mjs | UNPROVEN |
| 93 | Animation system | src/animation/AnimationSystem.js | scripts/animation-ragdoll-plan-witness.mjs | PROVEN |
| 94 | Animation controller | src/animation/AnimationController.js | - | UNPROVEN |
| 95 | Blend trees and animation blender | src/animation/BlendTree.js | - | UNPROVEN |
| 96 | Two-bone IK, foot IK and IK rig | src/animation/IKSolver.js | - | UNPROVEN |
| 97 | Procedural skeleton and skinned body | src/animation/ProceduralSkeleton.js | - | UNPROVEN |
| 98 | Ragdoll pose | src/animation/RagdollPose.js | scripts/animation-ragdoll-real-skeleton-witness.mjs | PROVEN |
| 99 | Ragdoll activation parse and plan check | src/animation/ragdollActivation.js | scripts/ragdoll-activation-witness.mjs | PROVEN |
| 100 | Ragdoll activation apply | src/animation/ragdollActivation.js | scripts/character-animator-ragdoll-witness.mjs | PROVEN |
| 101 | Shape key driver | src/animation/ShapeKeys.js | - | UNPROVEN |
| 102 | Spring bones | src/animation/SpringBones.js | - | UNPROVEN |
| 103 | Skeleton utilities | src/animation/SkeletonUtils.js | - | UNPROVEN |
| 104 | Heightfield binary codec decode (rejects bad magic and truncation) | packages/mapspinner/src/heightfield-codec.js | scripts/nearfield-lod-lattice-witness.mjs | PROVEN |
| 105 | Heightfield binary codec encode for baked .hf artifacts | packages/mapspinner/src/heightfield-codec.js | - | UNPROVEN |
| 106 | CPU height sampler createHeightSampler (parity source for the GLSL height graph) | packages/mapspinner/src/height-cpu.js | scripts/shared-lattice-surface-witness.mjs | PROVEN |
| 107 | GLSL-to-JS height transpile producing src/height-gen.js (generated, never hand-edited) | packages/mapspinner/src/height-gen.js | - | UNPROVEN |
| 108 | Single-source terrain defaults (TERRAIN_DEFAULTS) | packages/mapspinner/src/terrain-defaults.js | scripts/shared-lattice-surface-witness.mjs | PROVEN |
| 109 | Terrain carves applied to the CPU height sampler | packages/mapspinner/src/tsl/height-spec.js | - | UNPROVEN |
| 110 | Height hash-version backends (float v1 and integer v2) | packages/mapspinner/src/tsl/height-spec.js | - | UNPROVEN |
| 111 | Continental bias height term (CONTINENTAL_BIAS_AMP = 50) | packages/mapspinner/src/tsl/height-spec.js | - | UNPROVEN |
| 112 | Anchor field climate and elevation modulation (createAnchorField) | packages/mapspinner/src/anchor-field.js | - | UNPROVEN |
| 113 | Anchor field band detail overlay | packages/mapspinner/src/anchor-field-bands.js | - | UNPROVEN |
| 114 | HPF lattice build and face or pool samplers (hpfLattice, hpfFaceSampler, hpfPoolSampler) | packages/mapspinner/src/hpf-lattice.js | - | UNPROVEN |
| 115 | CPU vs GPU ground-height parity gate | packages/mapspinner/src/gl-render.js | - | UNPROVEN |
| 116 | Cube-sphere quadtree LOD selection per camera altitude | packages/mapspinner/src/quadtree.js | scripts/grass-seam-card-witness.mjs | PROVEN |
| 117 | Ground-per-face-metre LOD metric (groundPerFaceMetre) | packages/mapspinner/src/quadtree.js | scripts/grass-seam-card-witness.mjs | PROVEN |
| 118 | Local-to-deformed sphere mapping (localToDeformed) | packages/mapspinner/src/quadtree.js | - | UNPROVEN |
| 119 | LOD config resolution and application (resolveLodConfig, applyLodConfig) | packages/mapspinner/src/lod-config.js | scripts/shared-lattice-surface-witness.mjs | PROVEN |
| 120 | Cube-face selection and face-local projection (pickFace, worldToFaceLocal) | packages/mapspinner/src/planet-orchestrator-cull.js | scripts/grass-seam-card-witness.mjs | PROVEN |
| 121 | Frustum quad culling (quadOutsideFrustum, extractFrustumPlanes) | packages/mapspinner/src/planet-orchestrator-cull.js | - | UNPROVEN |
| 122 | Per-frame planet orchestration and renderer entry (initMapspinnerPlanet, splitFactor) | packages/mapspinner/src/planet-orchestrator.js | - | UNPROVEN |
| 123 | Patch grid geometry with outer skirt ring (buildGridGeometry) | packages/mapspinner/src/patch-grid-geometry.js | - | UNPROVEN |
| 124 | Zero-to-one depth perspective matrix (perspectiveZeroToOne) | packages/mapspinner/src/patch-grid-geometry.js | - | UNPROVEN |
| 125 | Patch baker height patches and thermal erosion (createPatchBaker, applyThermalErosion) | packages/mapspinner/src/patch-baker.js | - | UNPROVEN |
| 126 | Remote patch baker over a worker (createRemotePatchBaker) | packages/mapspinner/src/patch-baker-remote.js | - | UNPROVEN |
| 127 | Module worker job runner with timeout (runModuleWorkerJob) | packages/mapspinner/src/worker-job.js | - | UNPROVEN |
| 128 | Planet radius default and resolver (PLANET_RADIUS_M, resolvePlanetRadiusM) | packages/mapspinner/src/planet-radius.js | - | UNPROVEN |
| 129 | GPU pool and wetness parameter resolution (resolvePoolParams, resolveWetness) | packages/mapspinner/src/pool-params.js | - | UNPROVEN |
| 130 | Geomorph parent-grid snap across LOD levels (parentGridPosition) | packages/mapspinner/src/tsl/geomorph-snap-tsl.js | - | UNPROVEN |
| 131 | Transmittance LUT bake and verify (bakeTransmittanceLUT, verifyLUT) | packages/mapspinner/src/atmosphere-transmittance-lut.js | - | UNPROVEN |
| 132 | Scattering LUT bake and verify (bakeScatteringLUT, verifyScatteringLUT) | packages/mapspinner/src/atmosphere-scattering-lut.js | - | UNPROVEN |
| 133 | Off-thread atmosphere LUT bake job (bakeAtmosphereLUTs, startLutBakeWorker) | packages/mapspinner/src/atmosphere-lut-job.js | - | UNPROVEN |
| 134 | WebGPU atmosphere LUT texture upload and readback (createTransmittanceLutTexture, readBackLutTextureF32) | packages/mapspinner/src/webgpu/atmosphere-lut-compute.js | - | UNPROVEN |
| 135 | TSL sky radiance march (createSkyTSL, marchRadiance) | packages/mapspinner/src/tsl/sky-tsl.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 136 | WebGPU sky renderer (SkyRenderer, SKY_WGSL) | packages/mapspinner/src/webgpu/sky-render.js | - | UNPROVEN |
| 137 | Aerial-perspective gating in terrain lighting (apRad, apGate) | packages/mapspinner/src/tsl/terrain-lighting-tsl.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 138 | Legacy terrain lighting path (createLegacyTerrainLighting) | packages/mapspinner/src/tsl/terrain-lighting-tsl.js | - | UNPROVEN |
| 139 | Day/night ambient and terrain grade (terrainGrade, terrainDayShade, terrainSkyIrradiance) | packages/mapspinner/src/tsl/terrain-ambient-shared.js | - | UNPROVEN |
| 140 | WebGL2 terrain renderer entry (initMapspinnerRender, createRenderer) | packages/mapspinner/src/gl-render.js | - | UNPROVEN |
| 141 | Live GPU ground-height readback (sampleGroundM, sampleGroundMSync) | packages/mapspinner/src/gl-render.js | - | UNPROVEN |
| 142 | Terrain shader discards confined to the _WATERPASS_ block (keeps early-Z) | packages/mapspinner/src/shaders/terrain.glsl | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 143 | Fast-path render flags __vsCheap, __fsCheap and __halfResWater | packages/mapspinner/src/gl-render.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 144 | TSL planet material and mesh entry (initMapspinnerPlanetTSL) | packages/mapspinner/src/tsl/planet-tsl.js | - | UNPROVEN |
| 145 | Render order: terrain after opaque occluders, water before other transparents | packages/mapspinner/src/tsl/planet-tsl.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 146 | Water TSL with sea-level fragment discard (LAND_ABOVE_SEA_DISCARD_M) | packages/mapspinner/src/tsl/water-tsl.js | - | UNPROVEN |
| 147 | Sea wave height field (seaHeight, seaHeightLF, seaHeightMean) | packages/mapspinner/src/sea-waves.js | - | UNPROVEN |
| 148 | Far-distance splat fade (texFarFade) | packages/mapspinner/src/tsl/surface-splat-tsl.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 149 | Terrain albedo and climate splat blend (terrainAlbedoClimate, surfaceSplat) | packages/mapspinner/src/tsl/surface-splat-tsl.js | - | UNPROVEN |
| 150 | Splat weights per hash version (createSplatWeights) | packages/mapspinner/src/splat-weights.js | - | UNPROVEN |
| 151 | Surface texture set decode and sRGB linearisation (decodeSurfaceTextureSet, delin8) | packages/mapspinner/src/surface-texture-decode.js | - | UNPROVEN |
| 152 | Contact occlusion field (syncContactOcclusion, contactOcclusionFactor) | packages/mapspinner/src/tsl/contact-occlusion-tsl.js | - | UNPROVEN |
| 153 | Display-referred transfer (sceneLinearToDisplayReferred) | packages/mapspinner/src/tsl/display-referred-tsl.js | - | UNPROVEN |
| 154 | Sculpt override TSL (createSculptOverrideTSL, SCULPT_RES) | packages/mapspinner/src/tsl/sculpt-tsl.js | - | UNPROVEN |
| 155 | Height probe TSL and probe directions (createHeightProbeTSL, heightProbeDirs) | packages/mapspinner/src/tsl/height-probe-tsl.js | - | UNPROVEN |
| 156 | Demo tuning-panel registry entries (elevEdgeInset) are live overlays, not boot-time writers | packages/mapspinner/src/terrain-gen-controls.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 157 | VDRS render-scale gate (__vdrsScale read only when window.__vdrs === true) | packages/mapspinner/src/gl-render.js | scripts/lib/verify-doc-claims.mjs | PROVEN |
| 158 | VDRS upscale and composite passes (BilinearUpscale, Fsr1Upscale, DepthWriteback) | packages/mapspinner/src/webgpu/vdrs-composite.js | - | UNPROVEN |
| 159 | WebGPU terrain height compute (createTerrainHeightPipeline, computeTerrainHeights) | packages/mapspinner/src/webgpu/terrain-height-compute.js | - | UNPROVEN |
| 160 | WebGPU composeHeight compute (createTerrainComposeHeightPipeline, computeTerrainComposeHeights) | packages/mapspinner/src/webgpu/terrain-composeheight-compute.js | - | UNPROVEN |
| 161 | WebGPU height-tile bake to texture (THC_BAKE_RES = 130, bakeHeightTileTexture) | packages/mapspinner/src/webgpu/height-bake-compute.js | - | UNPROVEN |
| 162 | WebGPU ground probe compute (GroundProbe, createGroundProbe) | packages/mapspinner/src/webgpu/ground-probe-compute.js | - | UNPROVEN |
| 163 | WebGPU patch grid renderer (PatchGridRenderer, buildInstanceData) | packages/mapspinner/src/webgpu/patch-grid-render.js | - | UNPROVEN |
| 164 | WebGPU water renderer and occlusion probe (WaterRenderer, WaterOcclusionProbe) | packages/mapspinner/src/webgpu/water-render.js | - | UNPROVEN |
| 165 | WebGPU planet entry and capability detection (initMapspinnerPlanetWebGPU, supportsPlanetWebGPU) | packages/mapspinner/src/webgpu/planet-orchestrator-webgpu.js | - | UNPROVEN |
| 166 | WebGPU pipeline cache (MapspinnerPipelineCache, createPipelineCache) | packages/mapspinner/src/webgpu/pipeline-cache.js | - | UNPROVEN |
| 167 | SDK entry point exports (createRenderer, createPlanet, VERSION) | packages/mapspinner/src/index.js | - | UNPROVEN |
| 168 | Relative-import resolution across mapspinner src | packages/mapspinner/src/index.js | - | UNPROVEN |
| 169 | Three.js export-name resolution for mapspinner TSL modules | packages/mapspinner/src/tsl/planet-tsl.js | - | UNPROVEN |
| 170 | Bake code-version closure for the heightfield codec and shipped .hf artifacts | packages/mapspinner/src/heightfield-codec.js | - | UNPROVEN |
| 171 | Headless heightmap CLI (lab.mjs heightmap, PNG and stats) | packages/mapspinner/scripts/lab.mjs | - | UNPROVEN |
| 172 | GPU backend selection guard (backend-guard, backend-ab divergence verdict) | packages/mapspinner/scripts/backend-guard.mjs | - | UNPROVEN |
| 173 | Performance gate for the terrain renderer (perf-gate.mjs) | packages/mapspinner/scripts/perf-gate.mjs | - | UNPROVEN |
| 174 | Elevation A/B comparison script (ab-elevation.mjs) | packages/mapspinner/scripts/ab-elevation.mjs | - | UNPROVEN |
| 175 | Dev server with COOP/COEP headers and /diag and /cmd channel (server.js) | packages/mapspinner/server.js | - | UNPROVEN |
| 176 | In-page diagnostics probes window.__diag (planet.html) | packages/mapspinner/planet.html | - | UNPROVEN |
