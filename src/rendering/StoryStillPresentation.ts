import { resolveEase } from "../core/easing";
import type { AdvStillEntry } from "../types/AdvRuntime";
import type { StoryFrameLayout } from "./StoryFrameLayout";
import type { StoryRendererServiceKey } from "./StoryRendererExtensions";

export interface StoryStillTween {
  readonly node: string;
  readonly property: "position" | "scale" | "rotation";
  readonly at: number;
  readonly duration: number;
  readonly ease: number;
  readonly value: readonly number[];
  readonly relative?: boolean;
  readonly from?: boolean;
}
export interface StoryStillSequence {
  readonly id: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly tweens: readonly StoryStillTween[];
}
export interface StoryStillPresentation {
  readonly layout: StoryFrameLayout;
  readonly sequences: readonly StoryStillSequence[];
}
export interface StoryStillPresentationProvider {
  resolve(still: AdvStillEntry): StoryStillPresentation | undefined;
}
export const STORY_STILL_PRESENTATION_PROVIDER: StoryRendererServiceKey<StoryStillPresentationProvider> = Object.freeze(
  { id: "vega.stillPresentations" },
);
export interface StoryStillPose {
  readonly position: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
}
export interface StoryStillAnimationSnapshot {
  readonly sequence: string | null;
  readonly elapsed: number;
  readonly base: Readonly<Record<string, StoryStillPose>>;
}
interface Track {
  readonly tween: StoryStillTween;
  readonly start: readonly number[];
  readonly end: readonly number[];
  readonly ease: (value: number) => number;
}

/** Analytic sampling retains named nodes and does not replay earlier frames. */
export class StoryStillAnimator {
  private base: Readonly<Record<string, StoryStillPose>>;
  private poses: Readonly<Record<string, StoryStillPose>>;
  private sequence: StoryStillSequence | undefined;
  private tracks: readonly Track[] = [];
  private elapsed = 0;
  revision = 0;
  constructor(readonly presentation: StoryStillPresentation) {
    this.base = Object.fromEntries(
      presentation.layout.nodes.map((node) => [
        node.id,
        { position: [...node.position], scale: [...node.scale], rotation: node.rotation },
      ]),
    );
    this.poses = this.base;
  }
  get layout(): StoryFrameLayout {
    return {
      ...this.presentation.layout,
      nodes: this.presentation.layout.nodes.map((node) => ({ ...node, ...this.poses[node.id] })),
    };
  }
  play(index: number | string): void {
    this.base = this.poses;
    this.elapsed = 0;
    this.sequence =
      typeof index === "string"
        ? this.presentation.sequences.find((sequence) => sequence.id === index)
        : this.presentation.sequences[index];
    this.compile();
    this.sample(0);
  }
  stop(): void {
    this.base = this.poses;
    this.sequence = undefined;
    this.tracks = [];
    this.elapsed = 0;
  }
  update(deltaSeconds: number): void {
    if (!this.sequence || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const duration = this.sequence.duration;
    const next =
      this.sequence.loop && duration > 0
        ? (this.elapsed + deltaSeconds) % duration
        : Math.min(duration, this.elapsed + deltaSeconds);
    if (next === this.elapsed) return;
    this.elapsed = next;
    this.sample(next);
  }
  snapshot(): StoryStillAnimationSnapshot {
    return { sequence: this.sequence?.id ?? null, elapsed: this.elapsed, base: this.base };
  }
  restore(snapshot: StoryStillAnimationSnapshot): void {
    const base = snapshot.base;
    if (
      !Number.isFinite(snapshot.elapsed) ||
      snapshot.elapsed < 0 ||
      this.presentation.layout.nodes.some((node) => {
        const pose = base[node.id];
        return (
          !Object.hasOwn(base, node.id) ||
          !pose ||
          !Array.isArray(pose.position) ||
          pose.position.length !== 2 ||
          !Array.isArray(pose.scale) ||
          pose.scale.length !== 2 ||
          ![...pose.position, ...pose.scale, pose.rotation].every(Number.isFinite)
        );
      })
    )
      throw new TypeError("Invalid still animation state");
    const sequence =
      snapshot.sequence === null
        ? undefined
        : this.presentation.sequences.find((sequence) => sequence.id === snapshot.sequence);
    if (snapshot.sequence !== null && !sequence)
      throw new TypeError(`Still sequence is unavailable: ${snapshot.sequence}`);
    this.base = base;
    this.sequence = sequence;
    this.elapsed = snapshot.elapsed;
    this.compile();
    this.sample(this.elapsed);
  }
  private compile(): void {
    const tracks: Track[] = [];
    for (const tween of [...(this.sequence?.tweens ?? [])].sort((a, b) => a.at - b.at)) {
      if (
        !["position", "scale", "rotation"].includes(tween.property) ||
        ![tween.at, tween.duration, tween.ease].every(Number.isFinite) ||
        tween.at < 0 ||
        tween.duration < 0 ||
        tween.value.length !== (tween.property === "rotation" ? 1 : 2) ||
        !tween.value.every(Number.isFinite)
      )
        throw new TypeError("Invalid still tween");
      const pose = this.base[tween.node];
      if (!Object.hasOwn(this.base, tween.node) || !pose)
        throw new TypeError(`Still tween node is unavailable: ${tween.node}`);
      let start: readonly number[] = tween.property === "rotation" ? [pose.rotation] : pose[tween.property];
      for (const track of tracks)
        if (track.tween.node === tween.node && track.tween.property === tween.property)
          start = this.value(track, tween.at);
      let end = tween.value.map((value, index) => value + (tween.relative ? start[index]! : 0));
      if (tween.from) {
        const previous = start;
        start = end;
        end = [...previous];
      }
      tracks.push({ tween, start: [...start], end, ease: resolveEase(tween.ease) });
    }
    this.tracks = tracks;
  }
  private value(track: Track, time: number): readonly number[] {
    const progress =
      track.tween.duration <= 0 ? 1 : Math.max(0, Math.min(1, (time - track.tween.at) / track.tween.duration));
    const eased = track.ease(progress);
    return track.start.map((start, index) => start + (track.end[index]! - start) * eased);
  }
  private sample(time: number): void {
    const poses: Record<string, StoryStillPose> = { ...this.base };
    for (const track of this.tracks) {
      if (time < track.tween.at) continue;
      const values = this.value(track, time),
        pose = poses[track.tween.node]!;
      poses[track.tween.node] = {
        ...pose,
        [track.tween.property]: track.tween.property === "rotation" ? values[0] : [values[0], values[1]],
      };
    }
    this.poses = poses;
    this.revision++;
  }
}
