import type { StoryCanvasScaler } from "./StoryFrameLayout";

export interface StoryCanvasParticleBake {
  readonly system: string;
  readonly renderer: string;
  readonly anchorNode: string;
  readonly opacityNode: string;
  /** Column-major emitter coordinates to reference-canvas delta, +Y up/+Z forward. */
  readonly positionMatrix: readonly number[];
  readonly sizeScale: readonly [number, number, number];
  /** Particle dimensions before the canvas bake, used by billboard size limits. */
  readonly sizeLimitScale: readonly [number, number, number];
  readonly cameraWorldHeight: number;
  /** Orthographic camera far-minus-near range, shared by every canvas renderer. */
  readonly cameraDepthRange: number;
  readonly clipDepth: number;
  readonly timeScale: number;
  /** Physical camera plane used to construct stretched mesh head/tail vertices. */
  readonly physicalBake?: { readonly planeDistance: number };
}

export interface StoryCanvasParticleBakes {
  readonly version: 1;
  readonly canvasScaler?: StoryCanvasScaler;
  readonly layoutScales: readonly { readonly node: string; readonly scale: readonly [number, number, number] }[];
  readonly systems: readonly StoryCanvasParticleBake[];
}
