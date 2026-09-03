/**
 * Spoint TypeScript Type Definitions
 *
 * Complete type definitions for server-side (ctx) and client-side (engine) APIs.
 *
 * Usage:
 *   - Server apps: import { AppContext, AppDefinition } from 'spoint'
 *   - Client apps: import { RenderContext, ClientAppDefinition } from 'spoint'
 *   - Shared math: import { Vector3, Quaternion } from 'spoint'
 */

// Re-export math types
export type {
  Vector3,
  Quaternion,
  Vector4,
  Vector2,
  Matrix4,
  Color,
  Euler,
  RaycastResult,
  ConstraintConfig
} from './math';

// Re-export server context types
export type {
  Entity,
  PhysicsAPI,
  ColliderConfig,
  WorldAPI,
  EntityFilter,
  Player,
  PlayersAPI,
  PlayerAppearance,
  AnimationOpts,
  MovementOverride,
  TimeAPI,
  NetworkAPI,
  EventBus,
  ProximityCallback,
  ConfigChangeCallback,
  ShutdownCallback,
  StorageAPI,
  DebugUtil,
  InteractableConfig,
  TerrainAPI,
  TerrainConfig,
  EventLog,
  EventLogMeta,
  LagCompensator,
  AppContext,
  AppDefinition,
  EditorProp
} from './ctx';

// Re-export client engine types
export type {
  Camera,
  Scene,
  Object3D,
  Material,
  Geometry,
  Texture,
  Fog,
  Box3,
  Vector3Like,
  Vector4Like,
  InputState,
  Vector2Like,
  Touch,
  FrameTime,
  ClientPlayer,
  ClientEntity,
  CameraController,
  ServerEvent,
  HUDLayer,
  RenderContext,
  AudioOpts,
  RaycastHit,
  ClientAppDefinition,
  AppModule,
  SnapType,
  GlobalAppContext,
  MobileDevice,
  QualityPreset,
  RenderControls
} from './engine';

/**
 * Declare global window augmentations for client-side access
 */
declare global {
  interface Window {
    /**
     * Global app context (client-side)
     * Contains scene, camera, input, players, entities, etc.
     */
    __app?: any;

    /**
     * Grass system instance
     */
    __grass?: any;

    /**
     * Vegetation system instance
     */
    __veg?: any;

    /**
     * Rocks system instance
     */
    __rocks?: any;

    /**
     * Terrain instance
     */
    __terrain?: any;

    /**
     * Scene graph
     */
    __scene?: any;

    /**
     * Camera instance
     */
    __camera?: any;

    /**
     * Debug mode information
     */
    __debug?: any;

    /**
     * Device information
     */
    __deviceInfo?: any;

    /**
     * Server instance (Node.js)
     */
    __server?: any;

    /**
     * Time of day system
     */
    __timeOfDay?: any;

    /**
     * Floating origin coordinator
     */
    __floatingOrigin?: any;
  }
}

/**
 * Server-side app export shape
 */
export default interface AppExport {
  description?: string;
  server?: {
    editorProps?: Array<{
      key: string;
      label: string;
      type: string;
      default?: any;
      [key: string]: any;
    }>;
    setup?: (ctx: any) => void | Promise<void>;
    update?: (ctx: any, dt: number) => void;
    teardown?: (ctx: any) => void;
    onMessage?: (ctx: any, message: any) => void;
    onCollision?: (ctx: any, entityIdA: string, entityIdB: string) => void;
    onInteract?: (ctx: any, playerId: string) => void;
  };
  client?: {
    setup?: (ctx: any) => void | Promise<void>;
    render?: (ctx: any) => void;
    onEvent?: (ctx: any, event: any) => void;
    teardown?: (ctx: any) => void;
  };
}
