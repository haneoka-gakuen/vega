import type { AdvStageConfig } from "../types/AdvRuntime";
import type { StoryPoint3 } from "./StorySceneBackend";

const point = (source: Partial<StoryPoint3> | undefined, target: StoryPoint3): StoryPoint3 => {
  target.x = Number.isFinite(Number(source?.x)) ? Number(source?.x) : 0;
  target.y = Number.isFinite(Number(source?.y)) ? Number(source?.y) : 0;
  target.z = Number.isFinite(Number(source?.z)) ? Number(source?.z) : 0;
  return target;
};

/** Stage slots and focus anchors share the native ADV fallback order across renderers. */
export function resolveStoryStagePoint(
  stage: AdvStageConfig,
  positionType: unknown,
  target: StoryPoint3 = { x: 0, y: 0, z: 0 },
): StoryPoint3 {
  const key = positionType === undefined ? 5 : Number(positionType);
  return point(stage.positions?.[key] ?? stage.focusAnchors?.[key], target);
}

export function resolveStoryFocusPoint(
  stage: AdvStageConfig,
  positionType: unknown,
  target: StoryPoint3 = { x: 0, y: 0, z: 0 },
): StoryPoint3 {
  const key = positionType === undefined ? 5 : Number(positionType);
  return point(stage.focusAnchors?.[key] ?? stage.positions?.[key], target);
}
