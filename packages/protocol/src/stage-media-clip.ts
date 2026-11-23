import { parseStageMediaEffects, type VegaMediaEffects } from "./stage-media-effects.js";
import { parsePropertyAnimationClip, type PropertyAnimationClip } from "./property-animation.js";

export const MAX_STAGE_CLIP_VOLUME = 2;

export function parseStageClipGainAnimation(value: unknown): PropertyAnimationClip | undefined {
  if (value === undefined) return;
  const animation = parsePropertyAnimationClip(value);
  if (animation.tracks.some(({ channel }) => channel !== "volume"))
    throw new TypeError("Invalid gain animation channel");
  return animation;
}

export const STAGE_MEDIA_ANIMATION_CHANNELS = [
  "x",
  "y",
  "scaleX",
  "scaleY",
  "rotationDegrees",
  "flipHorizontal",
  "flipVertical",
  "opacity",
  "blurRadius",
  "mask.centerX",
  "mask.centerY",
  "mask.width",
  "mask.height",
  "mask.rotationDegrees",
  "mask.radius",
  "mask.feather",
  "colorGrade.exposure",
  "colorGrade.contrast",
  "colorGrade.saturation",
  "colorGrade.temperature",
  "colorGrade.tint",
  "colorGrade.strength",
] as const;
export interface VegaStageMediaClip extends VegaMediaEffects {
  source: string;
  mediaKind: "image" | "video";
  durationSeconds: number;
  offsetSeconds: number;
  playbackRate: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  fit: "contain" | "cover" | "stretch";
  audioEnabled: boolean;
  volume: number;
  order: number;
  compositeWithActors?: boolean;
  backdrop?: boolean;
  rotationDegrees?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  blurRadius?: number;
  loop?: boolean;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  fadeWindow?: { durationSeconds: number; offsetSeconds: number; playbackRate: number };
  visualAnimation?: PropertyAnimationClip;
  gainAnimation?: PropertyAnimationClip;
}

export function parseVegaStageMediaClip(input: Readonly<Record<string, unknown>>): VegaStageMediaClip {
  const number = (key: keyof VegaStageMediaClip, fallback: number, minimum: number, maximum: number): number => {
    const value = input[key] ?? fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)
      throw new TypeError(`Invalid media clip field: ${key}`);
    return value;
  };
  const {
    source,
    mediaKind,
    fit = "contain",
    audioEnabled = true,
    compositeWithActors,
    loop,
    fadeWindow,
    flipHorizontal,
    flipVertical,
  } = input;
  if (typeof source !== "string" || !source.trim()) throw new TypeError("Media source is required");
  if (mediaKind !== "video" && mediaKind !== "image") throw new TypeError("Invalid media clip kind");
  if (fit !== "contain" && fit !== "cover" && fit !== "stretch") throw new TypeError("Invalid media fit");
  if (typeof audioEnabled !== "boolean") throw new TypeError("Invalid media audio state");
  if (compositeWithActors !== undefined && typeof compositeWithActors !== "boolean")
    throw new TypeError("Invalid media composition layer");
  if (loop !== undefined && typeof loop !== "boolean") throw new TypeError("Invalid media loop state");
  if ([flipHorizontal, flipVertical].some((value) => value !== undefined && typeof value !== "boolean"))
    throw new TypeError("Invalid media flip state");
  if (fadeWindow !== undefined && (!fadeWindow || typeof fadeWindow !== "object" || Array.isArray(fadeWindow)))
    throw new TypeError("Invalid media fade window");
  const envelope = fadeWindow as Readonly<Record<string, unknown>> | undefined;
  const gainAnimation = parseStageClipGainAnimation(input.gainAnimation);
  const visualAnimation =
    input.visualAnimation === undefined ? undefined : parsePropertyAnimationClip(input.visualAnimation);
  if (
    visualAnimation?.tracks.some(
      ({ channel }) => !STAGE_MEDIA_ANIMATION_CHANNELS.some((supported) => supported === channel),
    )
  )
    throw new TypeError("Invalid media animation channel");
  const readEnvelope = (key: string, minimum: number): number => {
    const value = envelope?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
      throw new TypeError(`Invalid media fade field: ${key}`);
    return value;
  };
  return {
    source: source.trim(),
    mediaKind,
    fit,
    audioEnabled,
    durationSeconds: number("durationSeconds", 5, 0.001, Number.MAX_SAFE_INTEGER),
    offsetSeconds: number("offsetSeconds", 0, 0, Number.MAX_SAFE_INTEGER),
    playbackRate: number("playbackRate", 1, 0.0625, 16),
    x: number("x", 0, -4, 4),
    y: number("y", 0, -4, 4),
    width: number("width", 1, 0.001, 4),
    height: number("height", 1, 0.001, 4),
    opacity: number("opacity", 1, 0, 1),
    volume: number("volume", 1, 0, MAX_STAGE_CLIP_VOLUME),
    order: number("order", 0, -1_000_000, 1_000_000),
    ...(compositeWithActors ? { compositeWithActors } : {}),
    ...parseStageMediaEffects(input),
    ...(visualAnimation ? { visualAnimation } : {}),
    ...(gainAnimation ? { gainAnimation } : {}),
    ...(loop !== undefined ? { loop } : {}),
    ...(flipHorizontal ? { flipHorizontal: true } : {}),
    ...(flipVertical ? { flipVertical: true } : {}),
    ...(input.blurRadius !== undefined ? { blurRadius: number("blurRadius", 0, 0, 128) } : {}),
    ...(input.rotationDegrees !== undefined ? { rotationDegrees: number("rotationDegrees", 0, -36000, 36000) } : {}),
    ...(input.fadeInSeconds !== undefined
      ? { fadeInSeconds: number("fadeInSeconds", 0, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(input.fadeOutSeconds !== undefined
      ? { fadeOutSeconds: number("fadeOutSeconds", 0, 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(envelope
      ? {
          fadeWindow: {
            durationSeconds: readEnvelope("durationSeconds", 0.001),
            offsetSeconds: readEnvelope("offsetSeconds", 0),
            playbackRate: readEnvelope("playbackRate", 0.000001),
          },
        }
      : {}),
  };
}

export function stageMediaOpacity(clip: VegaStageMediaClip, seconds: number): number {
  const window = clip.fadeWindow;
  const time = (window?.offsetSeconds ?? 0) + seconds * (window?.playbackRate ?? 1);
  const duration = window?.durationSeconds ?? clip.durationSeconds;
  return (
    clip.opacity *
    Math.max(
      0,
      Math.min(
        1,
        clip.fadeInSeconds ? time / clip.fadeInSeconds : 1,
        clip.fadeOutSeconds ? (duration - time) / clip.fadeOutSeconds : 1,
      ),
    )
  );
}

export function parseVegaStageComposition(input: Readonly<Record<string, unknown>>) {
  const { aspectRatio, sourceLoop } = input;
  if (typeof aspectRatio !== "number" || !Number.isFinite(aspectRatio) || aspectRatio <= 0)
    throw new TypeError("Invalid composition aspect ratio");
  let loop: { start: number; end: number } | undefined;
  if (sourceLoop !== undefined) {
    if (!sourceLoop || typeof sourceLoop !== "object" || Array.isArray(sourceLoop))
      throw new TypeError("Invalid composition source loop");
    const { start, end } = sourceLoop as Readonly<Record<string, unknown>>;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    )
      throw new TypeError("Invalid composition source loop");
    loop = { start, end };
  }
  return {
    aspectRatio,
    transparentBackground: input.transparentBackground === true,
    includeDialogue: input.includeDialogue !== false,
    ...(loop ? { sourceLoop: loop } : {}),
    clip: parseVegaStageMediaClip({ ...input, source: "composition", mediaKind: "image", audioEnabled: false }),
  };
}

export function parseVegaBackdropAdjustment(
  input: Readonly<Record<string, unknown>>,
): VegaStageMediaClip & { backdrop: true } {
  return {
    ...parseVegaStageMediaClip({
      ...input,
      source: "backdrop",
      mediaKind: "image",
      audioEnabled: false,
      compositeWithActors: true,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      fit: "stretch",
      rotationDegrees: 0,
      flipHorizontal: false,
      flipVertical: false,
    }),
    backdrop: true,
  };
}

export function stageMediaAudioClip(clip: VegaStageMediaClip, clipId: string, trackName = clipId) {
  return {
    clipId,
    trackName,
    source: clip.source,
    sourceKind: "video" as const,
    category: "Se" as const,
    durationSeconds: clip.durationSeconds,
    offsetSeconds: clip.offsetSeconds,
    playbackRate: clip.playbackRate,
    volume: clip.volume,
    trackVolume: 1,
    fadeInSeconds: clip.fadeInSeconds ?? 0,
    fadeOutSeconds: clip.fadeOutSeconds ?? 0,
    loop: clip.loop ?? false,
    ...(clip.fadeWindow ? { sourceWindow: clip.fadeWindow } : {}),
    ...(clip.gainAnimation ? { gainAnimation: clip.gainAnimation } : {}),
    muted: false,
  };
}
