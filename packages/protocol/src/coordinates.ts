export interface ScenePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A fixed calibration camera in the scene's +X right, +Y up, +Z forward basis. */
export interface SceneCoordinateReference {
  readonly width: number;
  readonly height: number;
  readonly fov: number;
  readonly position: ScenePoint;
  /** Euler degrees, applied Z, X, then Y. */
  readonly rotation?: ScenePoint;
}

const finite = (value: number): number => {
  if (!Number.isFinite(value)) throw new RangeError("Scene coordinates must be finite");
  return value;
};

export function scenePlaneSize(reference: SceneCoordinateReference, depth: number): { width: number; height: number } {
  if (!(
    finite(reference.width) > 0 &&
    finite(reference.height) > 0 &&
    finite(depth) > 0 &&
    finite(reference.fov) > 0 &&
    reference.fov < 180
  ))
    throw new RangeError("A scene reference requires positive dimensions, depth, and a FOV between 0 and 180");
  const height = 2 * depth * Math.tan((reference.fov * Math.PI) / 360);
  return { width: (height * reference.width) / reference.height, height };
}

export function sceneReferenceDirection(reference: SceneCoordinateReference, point: ScenePoint): ScenePoint {
  const r = reference.rotation ?? { x: 0, y: 0, z: 0 },
    rad = Math.PI / 180;
  const x = finite(r.x) * rad,
    y = finite(r.y) * rad,
    z = finite(r.z) * rad;
  const a = Math.cos(z) * finite(point.x) - Math.sin(z) * finite(point.y);
  const b = Math.sin(z) * point.x + Math.cos(z) * point.y;
  const c = Math.cos(x) * b - Math.sin(x) * finite(point.z);
  const d = Math.sin(x) * b + Math.cos(x) * point.z;
  return {
    x: Math.cos(y) * a + Math.sin(y) * d,
    y: c,
    z: -Math.sin(y) * a + Math.cos(y) * d,
  };
}

export function scenePointFromNdc(
  reference: SceneCoordinateReference,
  x: number,
  y: number,
  depth: number,
): ScenePoint {
  const size = scenePlaneSize(reference, depth);
  const point = sceneReferenceDirection(reference, {
    x: (finite(x) * size.width) / 2,
    y: (finite(y) * size.height) / 2,
    z: depth,
  });
  return {
    x: finite(reference.position.x) + point.x,
    y: finite(reference.position.y) + point.y,
    z: finite(reference.position.z) + point.z,
  };
}

/** Resolve top-left-origin source pixels once, before animation or camera movement. */
export function scenePointFromPixels(
  reference: SceneCoordinateReference,
  x: number,
  y: number,
  depth: number,
): ScenePoint {
  return scenePointFromNdc(
    reference,
    (2 * finite(x)) / reference.width - 1,
    1 - (2 * finite(y)) / reference.height,
    depth,
  );
}

export function scenePointToNdc(reference: SceneCoordinateReference, point: ScenePoint): ScenePoint {
  const delta = {
    x: finite(point.x) - reference.position.x,
    y: finite(point.y) - reference.position.y,
    z: finite(point.z) - reference.position.z,
  };
  const right = sceneReferenceDirection(reference, { x: 1, y: 0, z: 0 });
  const up = sceneReferenceDirection(reference, { x: 0, y: 1, z: 0 });
  const forward = sceneReferenceDirection(reference, { x: 0, y: 0, z: 1 });
  const dot = (axis: ScenePoint) => delta.x * axis.x + delta.y * axis.y + delta.z * axis.z;
  const depth = dot(forward),
    size = scenePlaneSize(reference, depth);
  return {
    x: (dot(right) * 2) / size.width,
    y: (dot(up) * 2) / size.height,
    z: depth,
  };
}

const focusCoordinates = [-1.6, -1.2, -0.8, -0.4, 0, 0.4, 0.8, 1.2, 1.6];
const focusAnchors = Object.freeze(
  Object.fromEntries(focusCoordinates.map((x, index) => [index + 1, Object.freeze({ x, y: 0, z: 0 })])) as Record<
    number,
    ScenePoint
  >,
);
export const DEFAULT_SCENE_GEOMETRY = Object.freeze({
  fov: 39.6,
  cameraPosition: Object.freeze({ x: 0, y: 0, z: 0 }),
  cameraRotation: Object.freeze({ x: 0, y: 0, z: 0 }),
  characterFieldPosition: Object.freeze({ x: 0, y: -0.45, z: 5.5 }),
  backgroundFieldPosition: Object.freeze({ x: 0, y: 0, z: 16 }),
  characterFieldScale: 4,
  backgroundFieldScale: 1,
  positions: Object.freeze(
    Object.fromEntries([1, 3, 5, 7, 9].map((slot) => [slot, focusAnchors[slot]!])) as Record<number, ScenePoint>,
  ),
  focusAnchors,
});
