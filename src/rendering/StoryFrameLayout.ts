import type { AdvFrameEntry } from "../types/AdvRuntime";
import type { StoryRendererServiceKey } from "./StoryRendererExtensions";
import type { StoryStillExternalLayoutSource } from "./StoryStillExternalLayout";
import { resolveStoryStillExternalLayout, validateStoryStillExternalLayout } from "./StoryStillExternalLayout";

export interface StoryFrameNode {
  readonly id: string;
  readonly transformKind?: "rect" | "transform";
  readonly parent?: string;
  readonly siblingIndex?: number;
  readonly anchorMin: readonly [number, number];
  readonly anchorMax: readonly [number, number];
  readonly pivot: readonly [number, number];
  readonly position: readonly [number, number];
  readonly size: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  /** Optional native canvas dimensions; legacy authoring content remains 2D. */
  readonly positionZ?: number;
  readonly scaleZ?: number;
  readonly rotationQuaternion?: readonly [number, number, number, number];
  readonly opacity: number;
  readonly active: boolean;
  readonly aspect?: { readonly mode: number; readonly ratio: number };
  readonly image?: {
    readonly enabled?: boolean;
    readonly textureKey?: string;
    readonly texture?: string;
    readonly color: readonly [number, number, number, number];
    readonly blend: "normal" | "additive";
    readonly preserveAspect: boolean;
    readonly type?: number;
    readonly useSpriteMesh?: boolean;
    /** Original Sprite geometry for a decoded, trimmed PNG. */
    readonly sprite?: {
      readonly serializedFile: string;
      readonly objectId: string;
      readonly sourcePath: string;
      readonly sourceHash: string;
      readonly outputSHA256: string;
      readonly rect: readonly [number, number, number, number];
      readonly textureRect: readonly [number, number, number, number];
      readonly trimOffset: readonly [number, number];
      readonly padding: readonly [number, number, number, number];
      readonly pixelsPerUnit: number;
      readonly pivot: readonly [number, number];
      readonly border: readonly [number, number, number, number];
      readonly settingsRaw: number;
      readonly packingRotation: number;
      readonly packed: boolean;
    };
    /** Native tiled Image size in canvas units, before node transforms. */
    readonly tileSize?: readonly [number, number];
    /** Native sliced Sprite borders: left, bottom, right, top in canvas units. */
    readonly sliceBorder?: readonly [number, number, number, number];
    /** The same borders normalized to the complete, untrimmed Sprite texture. */
    readonly sliceUvBorder?: readonly [number, number, number, number];
    readonly fillCenter?: boolean;
  };
}
export interface StoryCanvasScaler {
  readonly referenceResolution: readonly [number, number];
  readonly screenMatchMode: number;
  readonly matchWidthOrHeight: number;
  readonly maxAspectThreshold?: number;
}
export interface StoryCanvasCamera extends StoryCanvasScaler {
  readonly fieldOfView: number;
  readonly nearClip: number;
  readonly farClip: number;
  readonly planeDistance: number;
  readonly hdr: boolean;
}
export interface StoryFrameLayout {
  readonly camera?: StoryCanvasCamera;
  readonly stillExternalLayout?: StoryStillExternalLayoutSource;
  readonly referenceWidth: number;
  readonly nodes: readonly StoryFrameNode[];
}
export interface StoryFrameLayoutProvider {
  resolve(frame: AdvFrameEntry): StoryFrameLayout | undefined;
}
export const STORY_FRAME_LAYOUT_PROVIDER: StoryRendererServiceKey<StoryFrameLayoutProvider> = Object.freeze({
  id: "vega.frameLayouts",
});

export interface StoryFramePlacement {
  readonly node: StoryFrameNode;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly transform: readonly [number, number, number, number, number, number];
  /** Column-major native canvas transform, before camera projection. */
  readonly transform3D?: readonly number[];
}
type Affine = readonly [number, number, number, number, number, number];
interface ResolvedFrameNode {
  width: number;
  height: number;
  pivot: readonly [number, number];
  opacity: number;
  transform: Affine;
  transform3D: readonly number[];
  planar?: boolean;
}
const multiply = (p: Affine, m: Affine): Affine => [
  p[0] * m[0] + p[2] * m[1],
  p[1] * m[0] + p[3] * m[1],
  p[0] * m[2] + p[2] * m[3],
  p[1] * m[2] + p[3] * m[3],
  p[0] * m[4] + p[2] * m[5] + p[4],
  p[1] * m[4] + p[3] * m[5] + p[5],
];
const IDENTITY_3D: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply3D = (a: readonly number[], b: readonly number[]): readonly number[] => {
  const result = new Array<number>(16);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      result[column * 4 + row] =
        a[row] * b[column * 4] +
        a[row + 4] * b[column * 4 + 1] +
        a[row + 8] * b[column * 4 + 2] +
        a[row + 12] * b[column * 4 + 3];
  return result;
};
const nativeTransform = (node: StoryFrameNode, px: number, py: number, sourceQuaternion = false): readonly number[] => {
  const q = node.rotationQuaternion ?? [0, 0, Math.sin(node.rotation / 2), Math.cos(node.rotation / 2)];
  const z = node.positionZ ?? 0,
    sz = node.scaleZ ?? 1;
  if (![...q, z, sz].every(Number.isFinite) || q.length !== 4) throw new TypeError("Invalid native canvas transform");
  const length = Math.hypot(...q);
  if (!(length > 0)) throw new TypeError("Invalid native canvas rotation");
  const [x, y, rz, w] = sourceQuaternion ? q : q.map((value) => value / length);
  const sx = node.scale[0],
    sy = node.scale[1];
  return [
    (1 - 2 * (y * y + rz * rz)) * sx,
    2 * (x * y + rz * w) * sx,
    2 * (x * rz - y * w) * sx,
    0,
    2 * (x * y - rz * w) * sy,
    (1 - 2 * (x * x + rz * rz)) * sy,
    2 * (y * rz + x * w) * sy,
    0,
    2 * (x * rz + y * w) * sz,
    2 * (y * rz - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    px,
    py,
    z,
    1,
  ];
};
export function resolveStoryCanvasScale(camera: StoryCanvasScaler, width: number, height: number): number {
  if (
    ![...camera.referenceResolution, camera.matchWidthOrHeight].every(Number.isFinite) ||
    !camera.referenceResolution.every((value) => value > 0)
  )
    throw new TypeError("Invalid native canvas scale");
  if (
    ![width, height].every((value) => value > 0 && Number.isFinite(value)) ||
    (camera.maxAspectThreshold !== undefined &&
      (!Number.isFinite(camera.maxAspectThreshold) || camera.maxAspectThreshold <= 0))
  )
    throw new TypeError("Invalid native canvas scale");
  const aspect = width / height;
  if (camera.maxAspectThreshold !== undefined && aspect > camera.maxAspectThreshold)
    return camera.maxAspectThreshold / aspect;
  const sx = width / camera.referenceResolution[0],
    sy = height / camera.referenceResolution[1];
  const match = Math.max(0, Math.min(1, camera.matchWidthOrHeight));
  return camera.screenMatchMode === 1
    ? Math.min(sx, sy)
    : camera.screenMatchMode === 2
      ? Math.max(sx, sy)
      : camera.screenMatchMode === 0
        ? 2 ** ((1 - match) * Math.log2(sx) + match * Math.log2(sy))
        : 1;
}
export function resolveStoryFrameLayout(
  layout: StoryFrameLayout,
  width: number,
  height: number,
): readonly StoryFramePlacement[] {
  if (
    !(layout.referenceWidth > 0) ||
    !Number.isFinite(layout.referenceWidth) ||
    layout.nodes.length > 16384 ||
    ![width, height].every((value) => value > 0 && Number.isFinite(value))
  )
    throw new TypeError("Invalid frame layout dimensions");
  const camera = layout.camera;
  let scale = width / layout.referenceWidth;
  if (camera) {
    if (
      ![camera.fieldOfView, camera.nearClip, camera.farClip, camera.planeDistance,
        ...camera.referenceResolution, camera.matchWidthOrHeight].every(Number.isFinite) ||
      !(camera.fieldOfView > 0 && camera.fieldOfView < 180 && camera.planeDistance > 0 &&
        camera.nearClip > 0 && camera.farClip > camera.nearClip) ||
      !camera.referenceResolution.every((value) => value > 0)
    )
      throw new TypeError("Invalid native canvas camera");
    scale = resolveStoryCanvasScale(camera, width, height);
  }
  const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
  if (nodes.size !== layout.nodes.length) throw new TypeError("Duplicate frame node identity");
  const externalContract = layout.stillExternalLayout ? validateStoryStillExternalLayout(layout.stillExternalLayout) : undefined;
  if (externalContract && (!camera || camera.referenceResolution[0]!==externalContract.referenceResolution[0] ||
      camera.referenceResolution[1]!==externalContract.referenceResolution[1] || camera.screenMatchMode!==externalContract.screenMatchMode ||
      camera.matchWidthOrHeight!==externalContract.matchWidthOrHeight || camera.maxAspectThreshold!==externalContract.maxAspectThreshold ||
      camera.planeDistance!==externalContract.canvas.m_PlaneDistance)) throw new TypeError("Still external camera/scaler mismatch");
  if (externalContract?.nodes.some((node) => node.rotation.slice(0,3).some((v)=>Math.abs(v)>1e-7)))
    throw new TypeError("Unsupported Still external parent rotation");
  const external = externalContract ? resolveStoryStillExternalLayout(externalContract,width,height) : undefined;
  const root: ResolvedFrameNode = external ? {
    width: external.target.rect[2], height: external.target.rect[3], pivot: external.target.pivot,
    opacity: external.target.active ? external.target.opacity : 0,
    transform: [external.target.transform[0], external.target.transform[1], external.target.transform[2], external.target.transform[3],
      external.target.transform[4] - external.logicalWidth / 2, external.target.transform[5] - external.logicalHeight / 2],
    transform3D: multiply3D([1,0,0,0,0,1,0,0,0,0,1,0,-external.logicalWidth/2,-external.logicalHeight/2,0,1], external.target.transform3D),
    planar: external.target.planar,
  } : {
    width: width / scale,
    height: height / scale,
    pivot: [0.5, 0.5],
    opacity: 1,
    transform: [1, 0, 0, 1, 0, 0],
    transform3D: IDENTITY_3D,
  };
  const cache = new Map<string, typeof root>(),
    visiting = new Set<string>();
  const resolve = (node: StoryFrameNode): typeof root => {
    const cached = cache.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id)) throw new TypeError("Cyclic frame hierarchy");
    visiting.add(node.id);
    if (node.parent && !nodes.has(node.parent)) throw new TypeError(`Missing frame parent: ${node.parent}`);
    const parent = node.parent ? resolve(nodes.get(node.parent)!) : root;
    if (external) {
      if (node.transformKind !== "rect" && node.transformKind !== "transform")
        throw new TypeError("Missing Still transform kind");
      const F = Math.fround, plain = node.transformKind === "transform";
      const parentNode = node.parent ? nodes.get(node.parent)! : undefined;
      const parentPlain = parentNode?.transformKind === "transform";
      const pw = parentPlain ? 0 : parent.width, ph = parentPlain ? 0 : parent.height;
      const pp = parentPlain ? [0,0] : parent.pivot;
      let min = node.anchorMin, max = node.anchorMax, position = node.position;
      let size = node.size;
      const aspect = node.aspect;
      if (!plain && aspect && aspect.ratio > 0) {
        const ownW=F(F(pw*F(max[0]-min[0]))+size[0]), ownH=F(F(ph*F(max[1]-min[1]))+size[1]);
        const delta=(value:number, axis:0|1) => F(value-F((axis===0?pw:ph)*F(max[axis]-min[axis])));
        if (aspect.mode===1) size=[size[0],delta(F(ownW/aspect.ratio),1)];
        else if (aspect.mode===2) size=[delta(F(ownH*aspect.ratio),0),size[1]];
        else if (aspect.mode===3 || aspect.mode===4) {
          min=[0,0];max=[1,1];position=[0,0];
          size=(F(ph*aspect.ratio)<pw)!==(aspect.mode===3) ? [0,delta(F(pw/aspect.ratio),1)] : [delta(F(ph*aspect.ratio),0),0];
        } else if (aspect.mode!==0) throw new TypeError("Unsupported Still aspect mode");
      }
      const minX=F(F(-pp[0]!*pw)+F(min[0]*pw)), maxX=F(F(-pp[0]!*pw)+F(max[0]*pw));
      const minY=F(F(-pp[1]!*ph)+F(min[1]*ph)), maxY=F(F(-pp[1]!*ph)+F(max[1]*ph));
      const x=plain?F(position[0]):F(F(minX+F(F(maxX-minX)*node.pivot[0]))+position[0]);
      const y=plain?F(position[1]):F(F(minY+F(F(maxY-minY)*node.pivot[1]))+position[1]);
      const q=node.rotationQuaternion ?? [0,0,Math.sin(node.rotation/2),Math.cos(node.rotation/2)];
      if(q.length!==4 || !q.every(Number.isFinite) || !(Math.hypot(...q)>0)) throw new TypeError("Invalid Still native rotation");
      const [qx,qy,qz,qw]=q, x2=F(qx!*2),y2=F(qy!*2),z2=F(qz!*2);
      const xx=F(qx!*x2),yy=F(qy!*y2),zz=F(qz!*z2),xy=F(qx!*y2),wz=F(qw!*z2);
      const transform=multiply(parent.transform,[F(F(1-F(yy+zz))*node.scale[0]),F(F(xy+wz)*node.scale[0]),
        F(F(xy-wz)*node.scale[1]),F(F(1-F(xx+zz))*node.scale[1]),x,y]);
      const planar=parent.planar!==false && !(node.positionZ??0) && Math.abs(qx!)<=1e-7 && Math.abs(qy!)<=1e-7;
      const result: ResolvedFrameNode={width:plain?0:F(F(maxX-minX)+size[0]),height:plain?0:F(F(maxY-minY)+size[1]),
        pivot:plain?[0,0]:node.pivot,opacity:node.active?F(parent.opacity*node.opacity):0,transform,
        transform3D:multiply3D(parent.transform3D,nativeTransform(node,x,y,true)),planar};
      cache.set(node.id,result);visiting.delete(node.id);return result;
    }
    let w = parent.width * (node.anchorMax[0] - node.anchorMin[0]) + node.size[0];
    let h = parent.height * (node.anchorMax[1] - node.anchorMin[1]) + node.size[1];
    const aspect = node.aspect;
    if (aspect && aspect.ratio > 0) {
      if (aspect.mode === 1) h = w / aspect.ratio;
      else if (aspect.mode === 2) w = h * aspect.ratio;
      else if (aspect.mode === 3 || aspect.mode === 4) {
        const fitWidth = parent.width / parent.height < aspect.ratio;
        if (fitWidth === (aspect.mode === 3)) {
          w = parent.width;
          h = w / aspect.ratio;
        } else {
          h = parent.height;
          w = h * aspect.ratio;
        }
      }
    }
    const x =
      parent.width * (node.anchorMin[0] + (node.anchorMax[0] - node.anchorMin[0]) * node.pivot[0] - parent.pivot[0]) +
      node.position[0];
    const y =
      parent.height * (node.anchorMin[1] + (node.anchorMax[1] - node.anchorMin[1]) * node.pivot[1] - parent.pivot[1]) +
      node.position[1];
    const cos = Math.cos(node.rotation),
      sin = Math.sin(node.rotation);
    const transform = multiply(parent.transform, [
      cos * node.scale[0],
      sin * node.scale[0],
      -sin * node.scale[1],
      cos * node.scale[1],
      x,
      y,
    ]);
    const result = {
      width: Math.max(0, w),
      height: Math.max(0, h),
      pivot: node.pivot,
      opacity: node.active ? parent.opacity * Math.max(0, Math.min(1, node.opacity)) : 0,
      transform,
      transform3D: camera ? multiply3D(parent.transform3D, nativeTransform(node, x, y)) : IDENTITY_3D,
    };
    cache.set(node.id, result);
    visiting.delete(node.id);
    return result;
  };
  const projection: Affine = [scale, 0, 0, -scale, width / 2, height / 2];
  return layout.nodes.map((node) => {
    const placement = resolve(node);
    return {
      node,
      width: placement.width,
      height: placement.height,
      opacity: placement.opacity,
      transform: multiply(multiply(projection, placement.transform), [1, 0, 0, -1, 0, 0]),
      ...(camera
        ? { transform3D: multiply3D(external && placement.planar ?
            [placement.transform[0],placement.transform[1],0,0,placement.transform[2],placement.transform[3],0,0,0,0,1,0,placement.transform[4],placement.transform[5],0,1] :
            placement.transform3D, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) }
        : {}),
    };
  });
}
