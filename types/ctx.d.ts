/**
 * Server-side Application Context (ctx) API
 * Provided to each app's setup(ctx), update(ctx, dt), and event handlers
 */

import { Vector3, Vector4, Quaternion, Color, Euler, RaycastResult, ConstraintConfig } from './math';

/**
 * Entity proxy providing access to entity properties and transformation
 */
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

/**
 * Physics API for entity collision and motion control
 */
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

/**
 * Collider configuration
 */
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

/**
 * World/entity query and spawning API
 */
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

/**
 * Entity query filter
 */
export interface EntityFilter {
  appName?: string;
  hasPhysics?: boolean;
  [key: string]: any;
}

/**
 * Player information
 */
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

/**
 * Players API for multiplayer management
 */
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

/**
 * Player appearance configuration
 */
export interface PlayerAppearance {
  tint?: Color;
  nameTag?: string;
}

/**
 * Animation options
 */
export interface AnimationOpts {
  loop?: boolean;
  fade?: number;
  [key: string]: any;
}

/**
 * Movement override configuration
 */
export interface MovementOverride {
  maxSpeed?: number;
  jumpImpulse?: number;
  acceleration?: number;
  [key: string]: any;
}

/**
 * Time information
 */
export interface TimeAPI {
  readonly tick: number;
  readonly deltaTime: number;
  readonly elapsed: number;
  readonly serverTime: number;

  after(seconds: number, callback: () => void): void;
  every(seconds: number, callback: () => void): void;
}

/**
 * Network API for messaging
 */
export interface NetworkAPI {
  broadcast(message: any): void;
  sendTo(playerId: string, message: any): void;
}

/**
 * Event bus for custom events
 */
export interface EventBus {
  on(event: string, callback: (...args: any[]) => void): () => void;
  off(event: string, callback: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;
}

/**
 * Proximity watch callback
 */
export type ProximityCallback = (ctx: AppContext, playerId: string) => void;

/**
 * Config change callback
 */
export type ConfigChangeCallback = (config: Record<string, any>) => void;

/**
 * Shutdown hook callback
 */
export type ShutdownCallback = () => void | Promise<void>;

/**
 * Storage API for persistent data
 */
export interface StorageAPI {
  get(key: string): any;
  set(key: string, value: any): void;
  delete(key: string): void;
  list(prefix?: string): string[];
  has(key: string): boolean;
}

/**
 * Debugger utility
 */
export interface DebugUtil {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
}

/**
 * Interactable configuration
 */
export interface InteractableConfig {
  radius?: number;
  prompt?: string;
  cooldown?: number;
}

/**
 * Terrain API
 */
export interface TerrainAPI {
  startStreaming(config: TerrainConfig): Promise<any>;
}

/**
 * Terrain configuration
 */
export interface TerrainConfig {
  [key: string]: any;
}

/**
 * Event log for audit trails
 */
export interface EventLog {
  record(type: string, data: any, meta?: EventLogMeta): void;
  query(filter: { type?: string; [key: string]: any }): any[];
}

/**
 * Event log metadata
 */
export interface EventLogMeta {
  actor?: string;
  reason?: string;
  context?: string;
  sourceApp?: string;
  sourceEntity?: string;
  causalEventId?: string;
  [key: string]: any;
}

/**
 * Lag compensator for network hit registration
 */
export interface LagCompensator {
  [key: string]: any;
}

/**
 * Main Application Context - provided to server-side app functions
 */
export interface AppContext {
  /**
   * Mutable state storage (JSON-serializable object)
   */
  state: Record<string, any>;

  /**
   * This entity's properties and methods
   */
  readonly entity: Entity;

  /**
   * Physics simulation API
   */
  readonly physics: PhysicsAPI;

  /**
   * Entity spawning and queries
   */
  readonly world: WorldAPI;

  /**
   * Connected players
   */
  readonly players: PlayersAPI;

  /**
   * Server time and tick information
   */
  readonly time: TimeAPI;

  /**
   * Configuration values from editor properties
   */
  readonly config: Record<string, any>;

  /**
   * Network messaging API
   */
  readonly network: NetworkAPI;

  /**
   * Event bus for custom events
   */
  readonly bus: EventBus | null;

  /**
   * Persistent storage API
   */
  readonly storage: StorageAPI | null;

  /**
   * Debug utility
   */
  readonly debug: DebugUtil;

  /**
   * Event log for audit trails
   */
  readonly eventLog: EventLog | null;

  /**
   * Lag compensator for hit registration
   */
  readonly lagCompensator: LagCompensator | null;

  /**
   * Get terrain height at world coordinates
   */
  terrainHeightAt(x: number, z: number): number | null;

  /**
   * Get terrain kind at world coordinates (e.g., 'road', 'river')
   */
  terrainKindAt(x: number, z: number): string | null;

  /**
   * Get navigation cost at world coordinates
   */
  navCostAt(x: number, z: number): number;

  /**
   * Get sea level Y coordinate
   */
  readonly seaLevel: number | null;

  /**
   * Get terrain body ID (physics)
   */
  readonly terrainBodyId: number | null;

  /**
   * Terrain streaming and queries
   */
  readonly terrain: TerrainAPI;

  /**
   * Line-of-sight test
   */
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

  /**
   * Raycast from a position in a direction
   */
  raycast(
    origin: Vector3,
    direction: Vector3,
    maxDistance?: number,
    excludeBodyId?: number | null
  ): RaycastResult;

  /**
   * Make this entity interactable
   */
  interactable(config?: InteractableConfig): void;

  /**
   * Watch for player proximity
   */
  onPlayerProximity(radius: number, callback: ProximityCallback): () => void;

  /**
   * React to config changes
   */
  onConfigChange(callback: ConfigChangeCallback): () => void;

  /**
   * Register cleanup callback on shutdown
   */
  onShutdown(callback: ShutdownCallback): () => void;

  /**
   * Define a game FSM
   */
  defineGameFSM(spec: any): any;

  /**
   * Define a game mode
   */
  defineGameMode(spec: any): any;

  /**
   * Define a buff/debuff stack
   */
  defineBuffStack(spec: any): any;

  /**
   * Define a shrinking zone
   */
  defineShrinkingZone(spec: any): any;

  /**
   * Define health system
   */
  defineHealth(spec: any): any;

  /**
   * Define steering behavior
   */
  defineSteering(spec: any): any;

  /**
   * Define checkpoint system
   */
  defineCheckpoint(spec: any): any;

  /**
   * Define pickup item
   */
  definePickup(spec: any): any;

  /**
   * Define destructible object
   */
  defineDestructible(spec: any): any;

  /**
   * Define softbody cloth simulation
   */
  defineSoftbody(spec: any): any;

  /**
   * Define fluid body
   */
  defineFluid(spec: any): any;

  /**
   * Define 3D fluid body
   */
  defineFluid3D(spec: any): any;

  /**
   * Define buoyancy
   */
  defineBuoyancy(spec: any): any;

  /**
   * Define teams system
   */
  defineTeams(spec: any): any;

  /**
   * Define weapon system
   */
  defineWeapon(spec: any): any;

  /**
   * Define player inventory
   */
  definePlayerInventory(spec: any): any;

  /**
   * Define path waypoints
   */
  definePath(points: Vector3[]): any;
}

/**
 * App definition for server-side
 */
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

/**
 * Editor property definition
 */
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
