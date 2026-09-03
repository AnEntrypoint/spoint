// Ambient typings for the ctx.* SDK surface passed into every app's server.setup()/update()/onMessage()
// etc (src/apps/AppContext.js). Loaded into Monaco via addExtraLib so app authors get real
// autocomplete instead of guessing method names -- kept hand-written and minimal (real return
// shapes are mostly plain objects/arrays, not modeled exhaustively). Regenerate by hand when
// AppContext.js's public surface changes; this file is NOT auto-derived.

declare const ctx: AppCtx

interface AppCtx {
  readonly entity: EntityProxy
  readonly physics: PhysicsAPI
  readonly world: WorldAPI
  readonly players: PlayersAPI
  readonly config: any
  readonly state: any
  readonly bus: BusScope | null

  onConfigChange(cb: (config: any) => void): void
  onPlayerProximity(radius: number, callback: (playerId: string, entered: boolean) => void): void
  interactable(config?: { prompt?: string, radius?: number }): void

  raycast(origin: [number, number, number], direction: [number, number, number], maxDistance?: number, excludeBodyId?: any): { hit: boolean, position?: [number, number, number], normal?: [number, number, number], entityId?: string }
  canSee(fromPos: [number, number, number], toPos: [number, number, number], opts?: any): boolean
  terrainHeightAt(x: number, z: number): number

  // ctx.define* factories -- each wires a reusable behavior (see apps/_lib/*.js) against this ctx.
  defineGameFSM(spec: any): any
  defineBuffStack(spec: any): any
  defineShrinkingZone(spec: any): any
  defineHealth(spec: any): any
  defineSteering(spec: any): any
  defineCheckpoint(spec: any): any
  definePickup(spec: any): any
  defineDestructible(spec: any): any
  defineTeams(spec: any): any
  defineWeapon(spec: any): any
  definePlayerInventory(spec: any): any
  definePath(points: [number, number, number][]): any
}

interface EntityProxy {
  readonly id: string
  readonly model: string | undefined
  position: [number, number, number]
  rotation: [number, number, number, number]
  scale: [number, number, number]
  velocity: [number, number, number]
  custom: Record<string, any> | null
  readonly parent: string | undefined
  readonly children: string[]
  readonly worldTransform: any
  destroy(): void
}

interface PhysicsAPI {
  // Applies an instantaneous impulse via the low-level physics engine (internally addImpulse on the body);
  // there is no separate PhysicsAPI.addImpulse -- use addForce here, or WorldAPI.applyImpulse(entityId, impulse, worldPoint).
  addForce(force: [number, number, number]): void
  setVelocity(velocity: [number, number, number]): void
  setFriction(friction: number): void
  setRestitution(restitution: number): void
  isAtRest(): boolean
  tiltFromUpright(): number
  [key: string]: any
}

interface WorldAPI {
  spawn(id: string, cfg?: any): any
  spawnChild(id: string, cfg?: any): any
  destroy(id: string): void
  attach(entityId: string, app: string): void
  detach(entityId: string): void
  reparent(entityId: string, parentId: string | null): void
  query(filter: (entity: any) => boolean): any[]
  getEntity(id: string): any
  nearby(pos: [number, number, number], radius: number): any[]
  sendToEntity(entityId: string, msg: any): void
  applyImpulse(entityId: string, impulse: [number, number, number], worldPoint?: [number, number, number]): void
  setVelocity(entityId: string, velocity: [number, number, number]): void
  setGravityFactor(entityId: string, factor: number): void
  setPosition(entityId: string, position: [number, number, number], rotation?: [number, number, number, number]): void
  weld(entityA: string, entityB: string, opts?: any): any
  joint(entityA: string, entityB: string, opts?: any): any
  removeConstraint(constraintId: any): void
}

interface PlayersAPI {
  getAll(): any[]
  getById(id: string): any
  getNearest(pos: [number, number, number], radius?: number): any
  send(playerId: string, msg: any): void
  broadcast(msg: any): void
  broadcastNearby(pos: [number, number, number], radius: number, msg: any): void
  setPosition(playerId: string, pos: [number, number, number]): void
  setName(playerId: string, name: string): void
  setAppearance(playerId: string, appearance: any): void
  setModel(playerId: string, url: string): void
  setMovementOverride(playerId: string, overrides: any): void
  setLifecycle(playerId: string, state: 'alive' | 'frozen' | 'spectator', opts?: any): void
  playAnimation(playerId: string, clip: string, opts?: any): void
  attachEntity(playerId: string, entityId: string, offset?: [number, number, number]): void
  detachEntity(entityId: string): void
  onPlayerContact(radius: number, cb: (a: string, b: string) => void): void
  nearestOtherPlayer(playerId: string, radius?: number): any
  after(seconds: number, fn: () => void): void
  every(seconds: number, fn: () => void): void
}

interface BusScope {
  broadcast(msg: any): void
  sendTo(id: string, msg: any): void
}
