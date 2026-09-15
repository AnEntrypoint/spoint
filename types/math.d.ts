/** [x, y, z] tuple. */
export type Vector3 = [number, number, number];

/** [x, y, z, w] tuple. */
export type Quaternion = [number, number, number, number];

/** [x, y, z, w] tuple. */
export type Vector4 = [number, number, number, number];

/** [x, z] tuple (ground plane -- not [x, y]). */
export type Vector2 = [number, number];

/** Flat 16-element array (4x4). */
export type Matrix4 = number[];

/** Hex color (0xRRGGBB), or null. */
export type Color = number | null;

/** [x, y, z] in radians. */
export type Euler = [number, number, number];

export interface RaycastResult {
  hit: boolean;
  distance: number;
  position: Vector3 | null;
  normal: Vector3 | null;
  bodyId: number | null;
  entityId: string | null;
  body?: any;
}

export interface ConstraintConfig {
  type: 'fixed' | 'point' | 'distance' | 'hinge' | 'prismatic' | 'ball';
  [key: string]: any;
}
