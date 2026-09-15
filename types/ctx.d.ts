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

/** Opaque lag-compensation state used for network hit registration; shape is backend-specific. */
export interface LagCompensator {
  [key: string]: any;
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
  readonly lagCompensator: LagCompensator | null;

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
