import type { AdvFrameEntry } from "../types/AdvRuntime";
import type { StoryRendererServiceKey } from "./StoryRendererExtensions";

export interface StoryFrameNode {
  readonly id: string;
  readonly parent?: string;
  readonly anchorMin: readonly [number, number];
  readonly anchorMax: readonly [number, number];
  readonly pivot: readonly [number, number];
  readonly position: readonly [number, number];
  readonly size: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
  readonly opacity: number;
  readonly active: boolean;
  readonly aspect?: { readonly mode: number; readonly ratio: number };
  readonly image?: {
    readonly textureKey?: string;
    readonly texture?: string;
    readonly color: readonly [number, number, number, number];
    readonly blend: "normal" | "additive";
    readonly preserveAspect: boolean;
  };
}
export interface StoryFrameLayout {
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
}
type Affine = readonly [number, number, number, number, number, number];
interface ResolvedFrameNode {
  width: number;
  height: number;
  pivot: readonly [number, number];
  opacity: number;
  transform: Affine;
}
const multiply = (p: Affine, m: Affine): Affine => [
  p[0] * m[0] + p[2] * m[1],
  p[1] * m[0] + p[3] * m[1],
  p[0] * m[2] + p[2] * m[3],
  p[1] * m[2] + p[3] * m[3],
  p[0] * m[4] + p[2] * m[5] + p[4],
  p[1] * m[4] + p[3] * m[5] + p[5],
];
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
  const scale = width / layout.referenceWidth;
  const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
  if (nodes.size !== layout.nodes.length) throw new TypeError("Duplicate frame node identity");
  const root: ResolvedFrameNode = {
    width: layout.referenceWidth,
    height: height / scale,
    pivot: [0.5, 0.5],
    opacity: 1,
    transform: [1, 0, 0, 1, 0, 0],
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
    };
  });
}
