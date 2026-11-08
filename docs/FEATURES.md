# spoint features: netcode, protocol, client, sharding, static, animation

Scope: src/netcode, src/protocol, src/client, src/sharding, src/static, src/animation. Other source areas are not listed here yet.

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
