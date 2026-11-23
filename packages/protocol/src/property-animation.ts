export interface PropertyAnimationPoint {
  readonly timeSeconds: number;
  readonly value: number;
  readonly ease?: string | number;
  /** Subinterval of the original easing function after inserting a sampled keyframe. */
  readonly easeSpan?: { readonly start: number; readonly end: number; readonly amplitude: number };
}
export interface PropertyAnimationTrack {
  readonly channel: string;
  readonly points: readonly PropertyAnimationPoint[];
}
export interface PropertyAnimationClip {
  readonly durationSeconds: number;
  readonly sourceWindow?: {
    readonly offsetSeconds: number;
    readonly durationSeconds: number;
    readonly playbackRate: number;
  };
  readonly tracks: readonly PropertyAnimationTrack[];
}

export function parsePropertyAnimationClip(value: unknown): PropertyAnimationClip {
  const clip = value as PropertyAnimationClip;
  if (!clip || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds < 0 || !Array.isArray(clip.tracks))
    throw new TypeError("Invalid property animation clip");
  const channels = new Set<string>();
  const window = clip.sourceWindow;
  if (
    window &&
    (!Number.isFinite(window.offsetSeconds) ||
      window.offsetSeconds < 0 ||
      !Number.isFinite(window.playbackRate) ||
      window.playbackRate <= 0 ||
      !Number.isFinite(window.durationSeconds) ||
      window.offsetSeconds + clip.durationSeconds * window.playbackRate > window.durationSeconds + 0.000001)
  )
    throw new TypeError("Invalid property animation source window");
  for (const track of clip.tracks) {
    if (
      !track ||
      typeof track.channel !== "string" ||
      !track.channel ||
      channels.has(track.channel) ||
      !Array.isArray(track.points) ||
      !track.points.length
    )
      throw new TypeError("Invalid property animation track");
    channels.add(track.channel);
    let previous = -1;
    for (const point of track.points) {
      if (
        !point ||
        !Number.isFinite(point.timeSeconds) ||
        point.timeSeconds < 0 ||
        point.timeSeconds < previous ||
        point.timeSeconds > (window?.durationSeconds ?? clip.durationSeconds) ||
        !Number.isFinite(point.value)
      )
        throw new TypeError("Invalid property animation point");
      previous = point.timeSeconds;
      const span = point.easeSpan;
      if (
        span &&
        (!Number.isFinite(span.start) ||
          !Number.isFinite(span.end) ||
          !Number.isFinite(span.amplitude) ||
          span.start < 0 ||
          span.start >= span.end ||
          span.end > 1)
      )
        throw new TypeError("Invalid easing interval");
    }
  }
  return clip;
}
