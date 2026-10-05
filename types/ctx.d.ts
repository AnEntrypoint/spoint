/** Server-side Application Context (ctx), passed to each app's setup(ctx), update(ctx, dt), and event handlers. */

import { Vector3, Vector4, Quaternion, Color, Euler, RaycastResult, ConstraintConfig } from './math';

export interface Entity {
  readonly id: string;
  readonly model?: string;
  readonly bodyType: 'dynamic' | 'kinematic' | 'static';
  position: Vector3;
  rotation: Quaternion;
  scale: Vector3;
  velocity: Vector3;
  custom: Record<string, any> | null;
  readonly parent?: string | null;
  readonly children: string[];
  readonly worldTransform: {
    position: Vector3;
    rotation: Quaternion;
    scale: Vector3;
  };
  destroy(): void;
}

export interface PhysicsAPI {
  // Setters for body type
  setStatic(isStatic: boolean): void;
  setDynamic(isDynamic: boolean): void;
  setKinematic(isKinematic: boolean): void;

  // Mass and damping
  setMass(mass: number): void;
  setLinearDamping(value: number): void;
  setAngularDamping(value: number): void;

  // CCD (Continuous Collision Detection) policy
  setCCDPolicy(policy: 'auto' | 'always' | 'off'): void;

  // Collider shapes
  addBoxCollider(size: Vector3 | number, shapeKey?: string): void;
  addSphereCollider(radius: number, shapeKey?: string): void;
  addCapsuleCollider(radius: number, height: number, shapeKey?: string): void;
  addCylinderCollider(radius: number, height: number, shapeKey?: string): void;
  addTrimeshCollider(): Promise<void>;
  addConvexHullCollider(shapeKey?: string): void;

  // Collider configuration from config object
  addColliderFromConfig(config: ColliderConfig): void;

  // Forces and motion
  addForce(force: Vector3): void;
  addTorque(torque: Vector3): void;
  setVelocity(velocity: Vector3): void;
  addVelocity(delta: Vector3): void;
  getVelocity(): Vector3;
  setAngularVelocity(velocity: Vector3): void;

  // Interactability
  setInteractable(radius?: number): void;
}

export interface ColliderConfig {
  type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'trimesh' | 'convex-hull';
  size?: Vector3 | number;
  radius?: number;
  height?: number;
  mass?: number;
  dynamic?: boolean;
  kinematic?: boolean;
  ccd?: 'auto' | 'always' | 'off';
  shapeKey?: string;
  [key: string]: any;
}

export interface WorldAPI {
  // Spawning
  spawn(appName: string, config?: Record<string, any>): Entity;
  spawnChild(appName: string, config?: Record<string, any>): Entity;

  // Entity access
  getEntity(id: string): Entity | null;
  destroy(id: string): void;
  query(filter?: EntityFilter): Entity[];
  nearby(position: Vector3, radius: number): Entity[];

  // App attachment
  attach(entityId: string, appName: string): void;
  detach(entityId: string): void;

  // Hierarchy
  reparent(entityId: string, parentId: string): void;

  // Cross-entity messaging
  sendToEntity(entityId: string, message: any): void;

  // Cross-entity physics
  applyImpulse(entityId: string, impulse: Vector3, worldPoint?: Vector3): void;
  setVelocity(entityId: string, velocity: Vector3): void;
  setGravityFactor(entityId: string, factor: number): void;

  // Body lifecycle
  setBodyActive(entityId: string, active: boolean): void;
  setPosition(entityId: string, position: Vector3, rotation?: Quaternion): void;
  setMotionType(entityId: string, type: 'dynamic' | 'kinematic' | 'static'): boolean;
  isAtRest(entityId: string, epsilon?: number): boolean;

  // Constraints/Joints
  weld(entityA: string, entityB: string, opts?: ConstraintConfig): string;
  joint(entityA: string, entityB: string, opts: ConstraintConfig): string;
  removeConstraint(constraintId: string): void;

  readonly gravity: Vector3;
}

export interface EntityFilter {
  appName?: string;
  hasPhysics?: boolean;
  [key: string]: any;
}

export interface Player {
  readonly id: string;
  readonly name: string;
  readonly state?: {
    position?: Vector3;
    rotation?: Quaternion;
    velocity?: Vector3;
    onGround?: boolean;
    health?: number;
    /** Flat [nx, nz, nx, nz, ...] horizontal normals of the static walls the character touched this tick; the owning client receives them as wall-plane prediction hints (snapshot self block `me[3]`, protocol v4). */
    wallNormals?: number[] | null;
    [key: string]: any;
  };
  readonly appearance?: {
    tint?: Color;
    nameTag?: string;
  };
}

export interface PlayersAPI {
  // Access
  getAll(): Player[];
  getById(id: string): Player | null;
  getNearest(position: Vector3, radius: number): Player | null;

  // Messaging
  send(playerId: string, message: any): void;
  broadcast(message: any): void;
  broadcastNearby(position: Vector3, radius: number, message: any): void;

  // Position
  setPosition(playerId: string, position: Vector3): void;

  // Appearance
  setName(playerId: string, name: string): void;
  setAppearance(playerId: string, appearance: PlayerAppearance): void;
  setModel(playerId: string, url: string): void;

  // Animation and state
  setWeapon(playerId: string, name: string): void;
  playAnimation(playerId: string, clipName: string, opts?: AnimationOpts): void;
  setLifecycle(playerId: string, state: 'alive' | 'frozen' | 'spectator', opts?: any): void;

  // Movement
  setMovementOverride(playerId: string, overrides: MovementOverride | null): void;

  // Entity attachment
  attachEntity(playerId: string, entityId: string, offset: Vector3): void;
  detachEntity(entityId: string): void;

  // Proximity
  onPlayerContact(radius: number, callback: (playerIdA: string, playerIdB: string) => void): () => void;
  nearestOtherPlayer(playerId: string, radius: number): Player | null;
}

export interface PlayerAppearance {
  tint?: Color;
  nameTag?: string;
}

export interface AnimationOpts {
  loop?: boolean;
  fade?: number;
  [key: string]: any;
}

export interface MovementOverride {
  maxSpeed?: number;
  jumpImpulse?: number;
  acceleration?: number;
  [key: string]: any;
}

export interface TimeAPI {
  readonly tick: number;
  readonly deltaTime: number;
  readonly elapsed: number;
  readonly serverTime: number;

  after(seconds: number, callback: () => void): void;
  every(seconds: number, callback: () => void): void;
}

export interface NetworkAPI {
  broadcast(message: any): void;
  sendTo(playerId: string, message: any): void;
}

export interface EventBus {
  on(event: string, callback: (...args: any[]) => void): () => void;
  off(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
}

export type ProximityCallback = (ctx: AppContext, playerId: string) => void;

export type ConfigChangeCallback = (config: Record<string, any>) => void;

export type ShutdownCallback = () => void | Promise<void>;

export interface StorageAPI {
  get(key: string): any;
  set(key: string, value: any): void;
  delete(key: string): void;
  list(prefix?: string): string[];
  has(key: string): boolean;
}

export interface DebugUtil {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

export interface InteractableConfig {
  radius?: number;
  prompt?: string;
  cooldown?: number;
}

export interface TerrainAPI {
  startStreaming(config: TerrainConfig): Promise<any>;
}

export interface TerrainConfig {
  [key: string]: any;
}

export interface EventLog {
  record(type: string, data: any, meta?: EventLogMeta): void;
  query(filter: { type?: string; [key: string]: any }): any[];
}

export interface EventLogMeta {
  actor?: string;
  reason?: string;
  context?: string;
  sourceApp?: string;
  sourceEntity?: string;
  causalEventId?: string;
  [key: string]: any;
}

/** Rollback profile options; each value is a non-negative integer (validated at world load by `resolveNetcodeProfile`). */
export interface RollbackNetcodeOptions {
  /** Ticks between sampling local input and simulating it. Default 1. */
  inputDelayTicks?: number;
  /** A peer never simulates more than this many ticks past the slowest confirmed remote input; `maxRollbackTicks + inputDelayTicks` must stay below the snapshot ring size. Default 12. */
  maxRollbackTicks?: number;
  /** Ticks between settled-state checksum exchanges; mismatches count as desyncs. Default 30. */
  checksumIntervalTicks?: number;
}

/** Lockstep profile options; each value is a non-negative integer, `inputDelayTicks` and `maxCatchUpTicks` at least 1. */
export interface LockstepNetcodeOptions {
  /** Local input sampled while simulating tick t is scheduled for t + inputDelayTicks; set above one-way latency plus jitter, in ticks. Default 3. */
  inputDelayTicks?: number;
  /** Ticks between `ConsensusVoter` checksums; with 3+ peers a minority diverging on 3 consecutive checksums is ejected. Default 30. */
  checksumIntervalTicks?: number;
  /** Driver ticks a peer may be missing before it is dropped. Default 600. */
  stallTicks?: number;
  /** Maximum sim ticks run per driver tick while catching up after a stall. Default 4. */
  maxCatchUpTicks?: number;
}

/** World-definition `netcode` block; `src/netcode/NetcodeProfile.js` owns names, defaults and validation, a bad value throws at load. See docs/netcode.md. */
export interface NetcodeConfig {
  /** 'authoritative' (default): server simulation, client prediction, lag compensation. 'rollback' and 'lockstep': every peer simulates the whole world from exchanged inputs, no host; the sim must be deterministic. */
  profile?: 'authoritative' | 'rollback' | 'lockstep';
  /** Authoritative only: snapshots per second; defaults to the world tickRate. */
  snapshotRate?: number;
  /** Authoritative only: lag-compensation history window in ms (sets `LagCompensator.historyWindow`), the victim-fairness cap on rewind. Default 1000. */
  maxRewindMs?: number;
  /** Spin-precise server ticks (costs a core on Windows). */
  preciseTicks?: boolean;
  /** Rollback/lockstep: the session starts once this many peers agree on a roster. Default 2. */
  peers?: number;
  rollback?: RollbackNetcodeOptions;
  lockstep?: LockstepNetcodeOptions;
  /** Extra boolean input fields carried on the binary input wire. */
  inputButtons?: string[];
  /** Extra float input fields carried on the binary input wire. */
  inputAxes?: string[];
}

/** The world-definition fields app code reads to adapt to netcode and relocation; the full world file carries more. */
export interface WorldDefinition {
  name?: string;
  tickRate?: number;
  netcode?: NetcodeConfig;
  /** false rejects every MSG.TELEPORT relocation request (`window.__spoint.teleport`, `?at=`/`?bookmark=`/`?spawn=`) with "relocation disabled by this world". */
  relocation?: boolean;
  /** Equipment names in wire order: index 0 is `state.weapon` code 1, code 0 is unarmed. Declares what a game's gear is called so the engine never hard-codes it. */
  equipment?: string[];
  input?: {
    /** Mobile action buttons; each entry is `{ action, label?, icon?, grid?: [col, row] }`. Defaults to jump/crouch/interact. */
    mobileButtons?: Array<{ action: string; label?: string; icon?: string; grid?: [number, number] }>;
    [key: string]: any;
  };
  [key: string]: any;
}

/** Broadcast to server apps' `onMessage` (with no `senderId`) whenever the server places a player: a relocation teleport or a spawn snapped to ground after a hold. Velocity and queued input are zeroed and the player's lag-compensation history is cleared before it is sent. */
export interface PlayerTeleportMessage {
  type: 'player_teleport';
  playerId: number;
  position: [number, number, number];
  senderId?: undefined;
}

export interface RewoundPlayerState {
  tick: number;
  /** Monotonic ms when the sample was recorded; 0 on a freshly allocated result. */
  timestamp: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  velocity: [number, number, number];
}

export interface LagCompensatorStats {
  trackedPlayers: number;
  totalSamples: number;
  rewinds: number;
  clamped: number;
  rejected: number;
  rateLimited: number;
  maxRewindTicks: number;
  maxRewindMs: number;
}

/** Server-side rewind of player history for hit registration against what a shooter saw (authoritative profile). Player ids are the server's numeric player ids. */
export interface LagCompensator {
  /** History window in ms; world `netcode.maxRewindMs` or env SPOINT_LAG_HISTORY_WINDOW, default 1000. */
  historyWindow: number;
  readonly tickRate: number;
  readonly latestTick: number;
  /** historyWindow expressed in ticks, at least 1. */
  readonly windowTicks: number;
  setTickRate(tickRate: number): void;
  /** Called by the tick handler once per player per tick; apps do not need to call it. */
  recordPlayerPosition(playerId: number, position: Vector3, rotation: Quaternion, velocity: Vector3, tick: number): void;
  /** Validate a client-reported view tick (fire payload `viewTick`): null when non-finite or more than one tick in the future, clamped to the history window when too old. */
  resolveViewTick(reportedTick: number, currentTick?: number): number | null;
  /** Per-shooter token bucket (10 rewinds, refilling 20/s); false means resolve the shot against current state. */
  acceptRewind(shooterId: number, nowMs?: number): boolean;
  /** Player state blended between the two history samples bracketing a fractional tick, clamped to the oldest/newest sample, never extrapolated; pass `out` to reuse a result object. */
  rewindAtTick(playerId: number, tick: number, out?: RewoundPlayerState | null): RewoundPlayerState | null;
  /** rewindAtTick at `latestTick - millisAgo` converted to ticks. */
  getPlayerStateAtTime(playerId: number, millisAgo: number): RewoundPlayerState | null;
  /** The client origin if it lies within maxDriftM (default 2 m) of the shooter's eye, otherwise the server eye position. */
  validateShotOrigin(shooterPosition: Vector3, clientOrigin: Vector3 | undefined, eyeHeight: number, maxDriftM?: number): Vector3;
  /** True when newPosition is more than `threshold` (default 50 m) from the player's newest sample. */
  detectTeleport(playerId: number, newPosition: Vector3, threshold?: number): boolean;
  /** Drop a player's history and rewind bucket; relocation calls it so no shot rewinds across a teleport. */
  clearPlayerHistory(playerId: number): void;
  getStats(): LagCompensatorStats;
}

export interface AppContext {
  /** Must stay JSON-serializable -- it round-trips through persistence and the network wire. */
  state: Record<string, any>;

  readonly entity: Entity;
  readonly physics: PhysicsAPI;
  readonly world: WorldAPI;
  readonly players: PlayersAPI;
  readonly time: TimeAPI;

  /** Values come from this app instance's editor-configured properties, not global world config. */
  readonly config: Record<string, any>;

  readonly network: NetworkAPI;
  readonly bus: EventBus | null;
  readonly storage: StorageAPI | null;
  readonly debug: DebugUtil;
  readonly eventLog: EventLog | null;
  /** The server's lag compensator; null only when the runtime was built without one. */
  readonly lagCompensator: LagCompensator | null;

  /** Engine lag-compensated hitscan (src/netcode/Hitscan.js): normalizeShotDirection, resolveFireRequest, findHitSpatial(players, shot, liveIndex?), findHitLinear(players, shot), rayVsCapsule, hitHeightRatio, buildLiveIndex, DEFAULT_HITBOX, recordHit. A shot is { shooterId, origin, direction, viewTick, range, lagComp, isTargetable? }. */
  readonly combat: Record<string, any>;
  /** Kill-plane height under x/z: terrain height minus depth (default 20 m), or -20 without terrain. */
  fallFloorY(x: number, z: number, depth?: number): number;
  /** Least-occupied spawn point snapped onto walkable ground; exclude(player) skips players that should not count as occupants. */
  pickSpawnPoint(spawnPoints: number[][], opts?: { exclude?: (player: any) => boolean; minSafeDistance?: number }): number[];
  /** Debounced storage-backed value, cached per key on this context; await .ready before first read. */
  persisted<T>(key: string, initial: T, opts?: { debounceMs?: number }): { readonly ready: Promise<void>; value: T; save(): void; flush(): Promise<void> };
  /** Persistent per-scope leaderboard (asc keeps the lowest value, desc the highest), cached per key on this context. */
  leaderboard(key: string, opts?: { order?: 'asc' | 'desc'; maxEntries?: number }): { readonly ready: Promise<void>; record(scope: string, name: string, value: number): { recorded: boolean; rank: number | null; previousBest: number | null }; top(scope: string, n?: number): Array<{ name: string; value: number; ts: number }>; entryCount(): number; flush(): Promise<void> };

  /** Navmesh for a world file stem (defaults to the running world), built once per world and cached; rejects with a TypeError when the name is not a world file stem. */
  navmesh(worldName?: string): Promise<any>;

  terrainHeightAt(x: number, z: number): number | null;

  /** Terrain kind strings are open-ended, e.g. 'road', 'river'. */
  terrainKindAt(x: number, z: number): string | null;

  navCostAt(x: number, z: number): number;

  /** Curvature-aware local-Y of the planet waterline at this entity's x/z; null without a planet frame. */
  readonly seaLevel: number | null;

  /** Curvature-aware local-Y of the planet waterline at world x/z; null without a planet frame. */
  seaLevelAt(x: number, z: number): number | null;

  readonly terrainBodyId: number | null;
  readonly terrain: TerrainAPI;

  canSee(
    fromPos: Vector3,
    toPos: Vector3,
    opts?: {
      maxDistance?: number;
      excludeBodyId?: number;
      targetEntityId?: string;
      tolerance?: number;
    }
  ): boolean;

  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance?: number,
    excludeBodyId?: number | null
  ): RaycastResult;

  interactable(config?: InteractableConfig): void;
  onPlayerProximity(radius: number, callback: ProximityCallback): () => void;
  onConfigChange(callback: ConfigChangeCallback): () => void;
  onShutdown(callback: ShutdownCallback): () => void;

  defineGameFSM(spec: any): any;
  defineGameMode(spec: any): any;
  defineBuffStack(spec: any): any;
  defineShrinkingZone(spec: any): any;
  defineHealth(spec: any): any;
  /** Engine shooter loop (src/behaviours/combat.js): spawn points, health, ammo and reload, fall-kill, respawn with invulnerability, powerups with buffs, persisted kill/death/damage stats and the lag-compensated hit path. Returns { config, spawnPoints, statsOf, ammoOf, isRespawning, buffOf, setup(), tick(dt), handle(msg), flush() } -- keep the handle out of ctx.state. */
  defineCombat(spec?: any): any;
  /** Deterministic wildfire on a coarse planet-lattice cell grid (src/behaviours/fire.js): data-spec fuel classes, wind-biased spread with ember spotting, rain extinguish, regrowth, bounded active-cell budget. Only ignition/extinguish/wind/moisture/rain events travel the wire. Returns { ignite(position), igniteCell(face, I, J), extinguish(position, radiusM), setWind([x,y,z]), setMoisture(n), setRain(n), stateAt(position), applyRemote(msg), tick(dt), checksum(), rewindTo(tick), activeCount, stats }. Default off: nothing runs until an app calls it. */
  defineFire(spec?: any): any;
  defineSteering(spec: any): any;
  defineCheckpoint(spec: any): any;
  definePickup(spec: any): any;
  defineDestructible(spec: any): any;
  defineSoftbody(spec: any): any;
  defineFluid(spec: any): any;
  defineFluid3D(spec: any): any;
  defineBuoyancy(spec: any): any;
  defineTeams(spec: any): any;
  defineWeapon(spec: any): any;
  definePlayerInventory(spec: any): any;
  definePath(points: Vector3[]): any;
}

export interface AppDefinition {
  description?: string;
  server?: {
    editorProps?: EditorProp[];
    setup?(ctx: AppContext): void | Promise<void>;
    update?(ctx: AppContext, dt: number): void;
    teardown?(ctx: AppContext): void;
    onMessage?(ctx: AppContext, message: any): void;
    onCollision?(ctx: AppContext, entityId: string, otherEntityId: string): void;
    onInteract?(ctx: AppContext, playerId: string): void;
  };
  client?: any;
}

export interface EditorProp {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'color' | 'select' | 'range' | 'vector3';
  default?: any;
  options?: string[] | number[];
  min?: number;
  max?: number;
  step?: number;
}
