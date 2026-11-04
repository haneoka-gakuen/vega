export interface PropertyAnimationPoint {
  readonly timeSeconds: number;
  readonly value: number;
  readonly ease?: string | number;
}
export interface PropertyAnimationTrack {
  readonly channel: string;
  readonly points: readonly PropertyAnimationPoint[];
}
export interface PropertyAnimationClip {
  readonly durationSeconds: number;
  readonly tracks: readonly PropertyAnimationTrack[];
}

export function parsePropertyAnimationClip(value: unknown): PropertyAnimationClip {
  const clip = value as PropertyAnimationClip;
  if (!clip || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds < 0 || !Array.isArray(clip.tracks))
    throw new TypeError("Invalid property animation clip");
  const channels = new Set<string>();
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
        point.timeSeconds > clip.durationSeconds ||
        !Number.isFinite(point.value)
      )
        throw new TypeError("Invalid property animation point");
      previous = point.timeSeconds;
    }
  }
  return clip;
}
