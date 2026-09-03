/**
 * Math types shared between server and client
 */

/**
 * 3D Vector type [x, y, z]
 */
export type Vector3 = [number, number, number];

/**
 * Quaternion type [x, y, z, w]
 */
export type Quaternion = [number, number, number, number];

/**
 * 4D Vector type [x, y, z, w]
 */
export type Vector4 = [number, number, number, number];

/**
 * 2D Vector type [x, z]
 */
export type Vector2 = [number, number];

/**
 * Matrix 4x4 type
 */
export type Matrix4 = number[];

/**
 * Color type - hex number (0xRRGGBB) or null
 */
export type Color = number | null;

/**
 * Euler angles type [x, y, z] in radians
 */
export type Euler = [number, number, number];

/**
 * Raycast result from physics engine
 */
export interface RaycastResult {
  hit: boolean;
  distance: number;
  position: Vector3 | null;
  normal: Vector3 | null;
  bodyId: number | null;
  entityId: string | null;
  body?: any;
}

/**
 * Constraint/joint configuration
 */
export interface ConstraintConfig {
  type: 'fixed' | 'point' | 'distance' | 'hinge' | 'prismatic' | 'ball';
  [key: string]: any;
}
