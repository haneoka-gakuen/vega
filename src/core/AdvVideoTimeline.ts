/**
 * AdvVideoTimeline (ft-adv Runtime/Player/AdvVideoTimeline.cs): while a Clip
 * plays, Delay rows add their raw Duration to a target and wait until the
 * video's own clock reaches it. Rows between Delays therefore cost no
 * timeline time, pause/buffering hold the script with the picture, and speed
 * only acts through the video's playbackRate. Parameter1 on Delay is an
 * authoring annotation the game never reads.
 */

export interface VideoTimelineObservation {
  /** Presented media time in seconds, or undefined when no video is attached. */
  mediaTime: number | undefined;
  paused: boolean;
  ended: boolean;
  /** The element failed (MediaError): its clock no longer moves. */
  failed?: boolean;
}

/** The native abort threshold for a clock that stops advancing. */
const STALL_SECONDS = 5;

export class VideoTimeline {
  private active = false;
  private source: unknown = null;
  private start = 0;
  private target = 0;

  get isActive(): boolean {
    return this.active;
  }

  /** Accumulated Delay target relative to the clip's first frame. */
  get elapsedTarget(): number {
    return this.target;
  }

  /** Clip start: `mediaTime` is the presented time of the first frame (0 unless resumed mid-clip). */
  begin(source: unknown, mediaTime: number, target = 0): void {
    this.active = true;
    this.source = source;
    this.start = Math.max(0, mediaTime - target);
    this.target = Math.max(0, target);
  }

  end(source?: unknown): void {
    if (source !== undefined && source !== this.source) return;
    this.active = false;
    this.source = null;
    this.start = 0;
    this.target = 0;
  }

  /** Advance the target by one Delay row; returns the media time to wait for. */
  advance(duration: number): number {
    this.target += Math.max(0, Number.isFinite(duration) ? duration : 0);
    return this.start + this.target;
  }

  /**
   * Wait until the observed media clock reaches `until`. Resolves with the
   * seconds still owed when the video stops being a usable clock (ended,
   * detached, or stalled for STALL_SECONDS); the caller runs those as an
   * ordinary delay.
   */
  async waitUntil(
    until: number,
    observe: () => VideoTimelineObservation,
    nextFrame: (signal?: AbortSignal) => Promise<void>,
    now: () => number,
    signal?: AbortSignal,
  ): Promise<number> {
    let lastMedia = Number.NaN;
    let lastProgress = now();
    while (!signal?.aborted && this.active) {
      const observation = observe();
      const media = observation.mediaTime;
      if (media === undefined) return Math.max(0, until - (Number.isFinite(lastMedia) ? lastMedia : this.start));
      if (media >= until) return 0;
      if (observation.ended || observation.failed) return Math.max(0, until - media);
      if (media !== lastMedia) {
        lastMedia = media;
        lastProgress = now();
      } else if (!observation.paused && now() - lastProgress > STALL_SECONDS) {
        this.active = false;
        return Math.max(0, until - media);
      }
      await nextFrame(signal);
    }
    return 0;
  }
}
