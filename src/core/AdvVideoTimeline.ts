/**
 * Schedules clip cues in cumulative media seconds, independent of buffering,
 * presentation speed, or wall-clock time.
 */
export interface VideoTimelineObservation {
  mediaTime: number | undefined;
  paused: boolean;
  ended: boolean;
  failed?: boolean;
}

export type VideoTimelineWaitResult = "reached" | "cancelled" | "ended" | "detached" | "failed";

export class VideoTimeline {
  private active = false;
  private source: unknown = null;
  private start = 0;
  private target = 0;
  private generation = 0;

  get isActive(): boolean {
    return this.active;
  }

  get elapsedTarget(): number {
    return this.target;
  }

  begin(source: unknown, mediaTime: number, target = 0): void {
    this.generation += 1;
    this.active = true;
    this.source = source;
    this.start = Math.max(0, mediaTime - target);
    this.target = Math.max(0, target);
  }

  end(source?: unknown): void {
    if (source !== undefined && source !== this.source) return;
    this.generation += 1;
    this.active = false;
    this.source = null;
    this.start = 0;
    this.target = 0;
  }

  advance(duration: number): number {
    this.target += Math.max(0, Number.isFinite(duration) ? duration : 0);
    return this.start + this.target;
  }

  /** Buffering and pause never turn media seconds into wall-clock seconds. */
  async waitUntil(
    until: number,
    observe: () => VideoTimelineObservation,
    nextFrame: (signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<VideoTimelineWaitResult> {
    const generation = this.generation;
    while (!signal?.aborted && this.active && generation === this.generation) {
      const observation = observe();
      const media = observation.mediaTime;
      if (observation.failed) return "failed";
      if (media === undefined || !Number.isFinite(media)) return "detached";
      // Summing authored decimal durations can exceed an exact media boundary
      // by a few floating-point ulps (for example 54.5 seconds).
      if (media + Math.max(1, Math.abs(until)) * Number.EPSILON * 16 >= until) return "reached";
      if (observation.ended) return "ended";
      await nextFrame(signal);
    }
    return "cancelled";
  }
}
