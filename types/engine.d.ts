/**
 * Client-side Engine API
 * Provided to client app render() and event handlers
 */

import { Vector3, Vector4, Quaternion, Color } from './math';

/**
 * THREE.js Camera interface (PerspectiveCamera or OrthographicCamera)
 */
export interface Camera {
  position: Vector3Like;
  rotation: Vector3Like;
  quaternion: Vector4Like;
  updateMatrix(): void;
  updateProjectionMatrix(): void;
  getWorldDirection(target: Vector3Like): Vector3Like;
}

/**
 * THREE.js Scene interface
 */
export interface Scene {
  children: Object3D[];
  add(object: Object3D): Scene;
  remove(object: Object3D): Scene;
  getObjectByName(name: string): Object3D | undefined;
  traverse(callback: (object: Object3D) => void): void;
  background: Color | null;
  fog: Fog | null;
}

/**
 * THREE.js Object3D interface
 */
export interface Object3D {
  position: Vector3Like;
  rotation: Vector3Like;
  quaternion: Vector4Like;
  scale: Vector3Like;
  visible: boolean;
  parent: Object3D | null;
  children: Object3D[];
  name: string;
  userData: Record<string, any>;

  add(object: Object3D): this;
  remove(object: Object3D): this;
  traverse(callback: (object: Object3D) => void): void;
  updateMatrix(): void;
  updateMatrixWorld(force?: boolean): void;
}

/**
 * THREE.js Material interface
 */
export interface Material {
  name: string;
  side: number;
  transparent: boolean;
  opacity: number;
  needsUpdate: boolean;
  map: Texture | null;
  normalMap: Texture | null;
  roughnessMap: Texture | null;
  metalnessMap: Texture | null;

  clone(): Material;
  dispose(): void;
}

/**
 * THREE.js Geometry interface
 */
export interface Geometry {
  attributes: Record<string, any>;
  index: any;
  boundingBox: Box3 | null;

  computeBoundingBox(): void;
  dispose(): void;
}

/**
 * THREE.js Texture interface
 */
export interface Texture {
  url?: string;
  name: string;
  needsUpdate: boolean;

  clone(): Texture;
  dispose(): void;
}

/**
 * THREE.js Fog interface
 */
export interface Fog {
  color: Color;
  near: number;
  far: number;
}

/**
 * Bounding box
 */
export interface Box3 {
  min: Vector3Like;
  max: Vector3Like;
}

/**
 * Vector3-like object interface
 */
export interface Vector3Like {
  x: number;
  y: number;
  z: number;
  set?(x: number, y: number, z: number): Vector3Like;
  copy?(v: Vector3Like): Vector3Like;
}

/**
 * Vector4-like object interface
 */
export interface Vector4Like {
  x: number;
  y: number;
  z: number;
  w: number;
  set?(x: number, y: number, z: number, w: number): Vector4Like;
  copy?(v: Vector4Like): Vector4Like;
}

/**
 * Input state
 */
export interface InputState {
  // Keyboard
  keys: Record<string, boolean>;
  isKeyPressed(key: string): boolean;

  // Mouse
  mouseX: number;
  mouseY: number;
  mouseDelta: Vector2Like;
  isMousePressed(button: number): boolean;

  // Touch
  touches: Touch[];
  isTouching: boolean;
}

/**
 * Vector2-like object interface
 */
export interface Vector2Like {
  x: number;
  y: number;
}

/**
 * Touch point
 */
export interface Touch {
  identifier: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  pageX: number;
  pageY: number;
}

/**
 * Frame time information
 */
export interface FrameTime {
  readonly deltaTime: number;
  readonly elapsed: number;
  readonly frameCount: number;
  readonly fps: number;
}

/**
 * Player state on client
 */
export interface ClientPlayer {
  readonly id: string;
  readonly name: string;
  position: Vector3;
  rotation: Quaternion;
  velocity: Vector3;
  appearance?: {
    tint?: Color;
    nameTag?: string;
  };
  isLocalPlayer: boolean;
  isAlive: boolean;
  isFrozen: boolean;
  isSpectating: boolean;
}

/**
 * Entity state on client
 */
export interface ClientEntity {
  readonly id: string;
  readonly appName: string;
  position: Vector3;
  rotation: Quaternion;
  scale: Vector3;
  velocity: Vector3;
  custom: Record<string, any>;
  mesh?: Object3D;
}

/**
 * Camera controller interface
 */
export interface CameraController {
  camera: Camera;
  position: Vector3Like;
  target: Vector3Like;

  update(dt: number): void;
  reset(): void;
  setTarget(target: Vector3Like): void;
  setPosition(position: Vector3Like): void;
}

/**
 * Event emitted from server
 */
export interface ServerEvent {
  type: string;
  data?: any;
  playerId?: string;
  entityId?: string;
  [key: string]: any;
}

/**
 * HUD layer interface
 */
export interface HUDLayer {
  show(): void;
  hide(): void;
  update(state: any): void;
  dispose(): void;
}

/**
 * Render context provided to client app
 */
export interface RenderContext {
  /**
   * THREE.js scene
   */
  readonly scene: Scene;

  /**
   * Camera
   */
  readonly camera: Camera;

  /**
   * Canvas rendering context (WebGL or WebGPU)
   */
  readonly renderer: any;

  /**
   * Input state
   */
  readonly input: InputState;

  /**
   * Frame time
   */
  readonly time: FrameTime;

  /**
   * Local player
   */
  readonly localPlayer: ClientPlayer | null;

  /**
   * All players
   */
  readonly players: Map<string, ClientPlayer>;

  /**
   * All entities
   */
  readonly entities: Map<string, ClientEntity>;

  /**
   * Current viewing player ID (for spectator mode)
   */
  readonly playerId: string | null;

  /**
   * World configuration
   */
  readonly worldConfig: any;

  /**
   * Camera controller
   */
  readonly cameraController: CameraController | null;

  /**
   * Show HUD message
   */
  showMessage(text: string, duration?: number): void;

  /**
   * Show toast notification
   */
  showToast(text: string, type?: 'info' | 'success' | 'error'): void;

  /**
   * Play sound effect
   */
  playSound(name: string, opts?: AudioOpts): void;

  /**
   * Get entity by ID
   */
  getEntity(id: string): ClientEntity | null;

  /**
   * Get player by ID
   */
  getPlayer(id: string): ClientPlayer | null;

  /**
   * Raycast from camera
   */
  raycastFromCamera(x: number, y: number): RaycastHit | null;

  /**
   * Subscribe to server event
   */
  on(event: string, callback: (data: any) => void): () => void;

  /**
   * Send message to server
   */
  send(message: any): void;
}

/**
 * Audio options
 */
export interface AudioOpts {
  volume?: number;
  loop?: boolean;
  [key: string]: any;
}

/**
 * Raycast hit from camera
 */
export interface RaycastHit {
  point: Vector3;
  normal: Vector3;
  distance: number;
  object: Object3D;
  entityId?: string;
}

/**
 * Client app definition
 */
export interface ClientAppDefinition {
  /**
   * Initialize client-side app state
   */
  setup?(ctx: RenderContext): void | Promise<void>;

  /**
   * Render each frame
   */
  render?(ctx: RenderContext): void;

  /**
   * React to server events
   */
  onEvent?(ctx: RenderContext, event: ServerEvent): void;

  /**
   * Cleanup
   */
  teardown?(ctx: RenderContext): void;
}

/**
 * App module system
 */
export interface AppModule {
  setup?(ctx: RenderContext): void | Promise<void>;
  render?(ctx: RenderContext): void;
  onEvent?(ctx: RenderContext, event: ServerEvent): void;
  teardown?(ctx: RenderContext): void;
}

/**
 * Snap type for grid snapping
 */
export type SnapType = 'none' | 'grid' | 'vertex' | 'edge' | 'face';

/**
 * Global app context available on window.__app
 */
export interface GlobalAppContext {
  scene: Scene;
  camera: Camera;
  renderer: any;
  input: InputState;
  time: FrameTime;
  localPlayer: ClientPlayer | null;
  players: Map<string, ClientPlayer>;
  entities: Map<string, ClientEntity>;
  playerId: string | null;

  // Shortcuts
  showMessage(text: string, duration?: number): void;
  showToast(text: string, type?: 'info' | 'success' | 'error'): void;
  playSound(name: string, opts?: AudioOpts): void;
  on(event: string, callback: (data: any) => void): () => void;
  send(message: any): void;
}

/**
 * Mobile device info
 */
export interface MobileDevice {
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  os: 'iOS' | 'Android' | 'other';
  browser: string;
}

/**
 * Quality preset
 */
export interface QualityPreset {
  name: string;
  resolution: number;
  shadowResolution: number;
  shadowCascades: number;
  ssr: boolean;
  ssao: boolean;
  bloom: boolean;
  fsr: boolean;
  grass: boolean;
  vegetation: boolean;
}

/**
 * Render control settings
 */
export interface RenderControls {
  get(key: string): any;
  set(key: string, value: any): void;
  toggleDeviceMode(): void;
  toggleQuality(preset: string): void;
}
