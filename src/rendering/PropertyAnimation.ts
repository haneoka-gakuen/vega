import * as curves from "popmotion";
import { resolveEase, type TweenClock } from "../core/easing";

import {
  parsePropertyAnimationClip,
  type PropertyAnimationClip,
  type PropertyAnimationTrack,
} from "@haneoka/vega-protocol";
export {
  parsePropertyAnimationClip,
  type PropertyAnimationClip,
  type PropertyAnimationPoint,
  type PropertyAnimationTrack,
} from "@haneoka/vega-protocol";

export interface PropertyAnimationOptions {
  readonly parallel?: boolean;
  readonly replaceChannels?: boolean;
  readonly keep?: boolean;
  readonly immediate?: boolean;
  readonly signal?: AbortSignal;
}
export interface PropertyAnimationSnapshot {
  readonly target: string;
  readonly clip: PropertyAnimationClip;
  readonly elapsedSeconds: number;
  readonly keep: boolean;
}

type Values = Readonly<Record<string, number>>;
type Playback = Omit<PropertyAnimationSnapshot, "clip"> & {
  clip: PropertyAnimationClip;
  cancel(finish: boolean): void;
  readonly startedAt: number;
};

function sampleTrack(track: PropertyAnimationTrack, time: number): number {
  const points = track.points;
  let index = 0;
  while (index + 1 < points.length && points[index + 1]!.timeSeconds <= time) index++;
  const from = points[index]!,
    to = points[index + 1];
  if (!to || time <= from.timeSeconds) return from.value;
  const progress = (time - from.timeSeconds) / (to.timeSeconds - from.timeSeconds);
  const token = to.ease;
  const name = typeof token === "string" && token.startsWith("popmotion:") ? token.slice(10) : undefined;
  const ease =
    name && typeof curves[name as keyof typeof curves] === "function"
      ? (curves[name as keyof typeof curves] as (value: number) => number)
      : resolveEase(token);
  return from.value + (to.value - from.value) * ease(progress);
}

export function samplePropertyAnimation(clip: PropertyAnimationClip, timeSeconds: number): Values {
  return Object.fromEntries(clip.tracks.map((track) => [track.channel, sampleTrack(track, timeSeconds)]));
}

/** Serializable property tracks driven by the same clock as native scene animation. */
export class PropertyAnimationPlayer {
  private readonly active = new Set<Playback>();
  constructor(
    private readonly clock: TweenClock,
    private readonly write: (target: string, current: Values, planned: Values) => void,
  ) {}

  play(target: string, clip: PropertyAnimationClip, options: PropertyAnimationOptions = {}): Promise<void> {
    if (options.signal?.aborted || !clip.tracks.length) return Promise.resolve();
    for (const playback of [...this.active]) {
      if (playback.target !== target) continue;
      if (!options.parallel) playback.cancel(!playback.keep);
      else if (options.replaceChannels) {
        const channels = new Set(clip.tracks.map((track) => track.channel));
        const tracks = playback.clip.tracks.filter((track) => !channels.has(track.channel));
        if (!tracks.length) playback.cancel(false);
        else playback.clip = { ...playback.clip, tracks };
      }
    }
    if (options.immediate || clip.durationSeconds <= 0) {
      const end = samplePropertyAnimation(clip, clip.durationSeconds);
      this.write(target, end, end);
      return Promise.resolve();
    }
    return this.start({ target, clip, elapsedSeconds: 0, keep: options.keep === true }, options.signal);
  }

  cancel(target?: string, channels?: readonly string[]): void {
    const selected = channels ? new Set(channels) : undefined;
    for (const playback of [...this.active]) {
      if (target !== undefined && playback.target !== target) continue;
      const tracks = selected ? playback.clip.tracks.filter((track) => !selected.has(track.channel)) : [];
      if (!tracks.length) playback.cancel(false);
      else playback.clip = { ...playback.clip, tracks };
    }
  }

  snapshot(): readonly PropertyAnimationSnapshot[] {
    return [...this.active].map(({ target, clip, startedAt, keep }) => ({
      target,
      clip: structuredClone(clip),
      elapsedSeconds: Math.max(0, this.clock.nowSeconds() - startedAt),
      keep,
    }));
  }

  restore(snapshots: readonly PropertyAnimationSnapshot[]): void {
    for (const snapshot of snapshots) {
      if (
        !snapshot ||
        typeof snapshot.target !== "string" ||
        typeof snapshot.keep !== "boolean" ||
        !Number.isFinite(snapshot.elapsedSeconds) ||
        snapshot.elapsedSeconds < 0 ||
        !Number.isFinite(snapshot.clip?.durationSeconds) ||
        snapshot.clip.durationSeconds < 0 ||
        !Array.isArray(snapshot.clip.tracks)
      )
        throw new TypeError("Invalid property animation snapshot");
      parsePropertyAnimationClip(snapshot.clip);
    }
    this.cancel();
    for (const snapshot of snapshots) void this.start(structuredClone(snapshot));
  }

  private start(snapshot: PropertyAnimationSnapshot, signal?: AbortSignal): Promise<void> {
    const { target, clip, elapsedSeconds } = snapshot;
    return new Promise<void>((resolve) => {
      let unsubscribe: (() => void) | undefined,
        finished = false;
      const playback: Playback = {
        ...snapshot,
        startedAt: this.clock.nowSeconds() - elapsedSeconds,
        cancel: (finish) => {
          if (finished) return;
          finished = true;
          unsubscribe?.();
          signal?.removeEventListener("abort", abort);
          this.active.delete(playback);
          if (finish) {
            const end = samplePropertyAnimation(playback.clip, playback.clip.durationSeconds);
            this.write(target, end, end);
          }
          resolve();
        },
      };
      const abort = () => playback.cancel(false);
      const tick = (now: number) => {
        const elapsed = Math.max(0, now - playback.startedAt);
        const end = samplePropertyAnimation(playback.clip, playback.clip.durationSeconds);
        this.write(
          target,
          samplePropertyAnimation(playback.clip, Math.min(playback.clip.durationSeconds, elapsed)),
          end,
        );
        if (elapsed >= clip.durationSeconds) playback.cancel(false);
      };
      this.active.add(playback);
      signal?.addEventListener("abort", abort, { once: true });
      tick(this.clock.nowSeconds());
      if (!finished) {
        const remove = this.clock.subscribe(tick, abort);
        if (finished) remove();
        else unsubscribe = remove;
      }
      if (signal?.aborted) abort();
    });
  }
}
