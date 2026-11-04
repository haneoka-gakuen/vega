import type { StoryResourceResolver } from "../resources/StoryResourcePort";

export interface StoryAudioClip {
  clipId: string;
  source: string;
  trackName: string;
  category: "Bgm" | "Se" | "Voice";
  offsetSeconds: number;
  durationSeconds: number;
  playbackRate: number;
  volume: number;
  trackVolume: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  loop: boolean;
  muted: boolean;
}

export interface StoryAudioClipSnapshot {
  clip: StoryAudioClip;
  elapsedSeconds: number;
}

type PlayingClip = StoryAudioClipSnapshot & {
  done: Promise<void>;
  finish(): void;
  buffer: AudioBuffer;
  startedAt: number;
  source?: AudioBufferSourceNode;
  gain?: GainNode;
};

export function audioClipEnvelope(clip: StoryAudioClip, elapsed: number): number {
  const into = clip.fadeInSeconds > 0 ? elapsed / clip.fadeInSeconds : 1;
  const out = clip.fadeOutSeconds > 0 ? (clip.durationSeconds - elapsed) / clip.fadeOutSeconds : 1;
  return Math.max(0, Math.min(1, into, out));
}

export function scheduleAudioClipGain(
  gain: AudioParam,
  clip: StoryAudioClip,
  at: number,
  elapsed: number,
  volume: number,
): void {
  gain.cancelScheduledValues(at);
  gain.setValueAtTime(volume * audioClipEnvelope(clip, elapsed), at);
  const points = [clip.fadeInSeconds, clip.durationSeconds - clip.fadeOutSeconds, clip.durationSeconds];
  if (clip.fadeInSeconds + clip.fadeOutSeconds > clip.durationSeconds)
    points.push((clip.durationSeconds * clip.fadeInSeconds) / (clip.fadeInSeconds + clip.fadeOutSeconds));
  for (const time of [...new Set(points)]
    .filter((time) => time > elapsed && time <= clip.durationSeconds)
    .sort((a, b) => a - b))
    gain.linearRampToValueAtTime(volume * audioClipEnvelope(clip, time), at + time - elapsed);
}

/** Independent voices on the shared audio device; snapshots use authored seconds. */
export class AudioClipPlayer {
  private readonly decoded = new Map<string, AudioBuffer>();
  private readonly pending = new Map<string, Promise<AudioBuffer>>();
  private readonly playing = new Map<string, PlayingClip>();
  private readonly lifetime = new AbortController();
  private paused = false;
  private generation = 0;
  private capture?: AudioNode;
  private releaseDevice?: () => void;
  constructor(
    private readonly context: AudioContext,
    private readonly output: AudioNode,
    private readonly volume: (category: StoryAudioClip["category"]) => number,
    private readonly resources?: StoryResourceResolver,
    private readonly keepAlive?: () => () => void,
  ) {}

  private async decode(source: string): Promise<AudioBuffer> {
    const found = this.decoded.get(source);
    if (found) {
      this.decoded.delete(source);
      this.decoded.set(source, found);
      return found;
    }
    let pending = this.pending.get(source);
    if (!pending) {
      pending = (async () => {
        const bytes = this.resources?.canLoad(source)
          ? await this.resources.load(source, this.lifetime.signal)
          : new Uint8Array(await (await fetch(source, { signal: this.lifetime.signal })).arrayBuffer());
        let buffer: AudioBuffer;
        try {
          buffer = await this.context.decodeAudioData(new Uint8Array(bytes).buffer);
        } catch (error) {
          throw new Error("Audio file cannot be decoded", { cause: error });
        }
        this.lifetime.signal.throwIfAborted();
        this.decoded.set(source, buffer);
        let size = [...this.decoded.values()].reduce(
          (sum, value) => sum + value.length * value.numberOfChannels * 4,
          0,
        );
        for (const [key, value] of this.decoded) {
          if (size <= 128 * 1024 * 1024 && this.decoded.size <= 24) break;
          this.decoded.delete(key);
          size -= value.length * value.numberOfChannels * 4;
        }
        return buffer;
      })();
      this.pending.set(source, pending);
      void pending.finally(() => this.pending.delete(source)).catch(() => {});
    }
    return pending;
  }

  async play(clip: StoryAudioClip, elapsedSeconds = 0, signal?: AbortSignal): Promise<void> {
    if (
      !clip.clipId ||
      !clip.source ||
      !clip.trackName ||
      !["Bgm", "Se", "Voice"].includes(clip.category) ||
      ![
        clip.offsetSeconds,
        clip.durationSeconds,
        clip.playbackRate,
        clip.volume,
        clip.trackVolume,
        clip.fadeInSeconds,
        clip.fadeOutSeconds,
        elapsedSeconds,
      ].every((value) => Number.isFinite(value) && value >= 0) ||
      clip.durationSeconds === 0 ||
      clip.playbackRate === 0 ||
      clip.volume > 1 ||
      clip.trackVolume > 1
    )
      throw new TypeError("Invalid audio clip");
    if (signal?.aborted) return;
    const generation = this.generation;
    const buffer = await this.decode(clip.source);
    if (generation !== this.generation || this.lifetime.signal.aborted || signal?.aborted) return;
    if (clip.offsetSeconds >= buffer.duration) throw new RangeError("Audio trim starts after the source ends");
    this.stop(clip.clipId);
    const duration = clip.loop
      ? clip.durationSeconds
      : Math.min(clip.durationSeconds, (buffer.duration - clip.offsetSeconds) / clip.playbackRate);
    if (elapsedSeconds >= duration) return;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const entry: PlayingClip = {
      done,
      finish,
      clip: { ...clip, durationSeconds: duration },
      buffer,
      elapsedSeconds,
      startedAt: this.context.currentTime,
    };
    this.playing.set(clip.clipId, entry);
    const abort = () => {
      if (this.playing.get(clip.clipId) === entry) this.stop(clip.clipId);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (!this.paused) this.start(entry);
      await done;
    } catch (error) {
      this.stop(clip.clipId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private start(entry: PlayingClip): void {
    if (entry.elapsedSeconds >= entry.clip.durationSeconds) {
      this.stop(entry.clip.clipId);
      return;
    }
    this.releaseDevice ??= this.keepAlive?.();
    const { clip } = entry,
      source = this.context.createBufferSource(),
      gain = this.context.createGain();
    source.buffer = entry.buffer;
    source.loop = clip.loop;
    source.loopStart = clip.offsetSeconds;
    source.loopEnd = entry.buffer.duration;
    source.playbackRate.value = clip.playbackRate;
    source.connect(gain);
    gain.connect(this.output);
    if (this.capture) gain.connect(this.capture);
    entry.gain = gain;
    entry.startedAt = this.context.currentTime;
    this.updateGain(entry);
    const available = entry.buffer.duration - clip.offsetSeconds;
    const advanced = entry.elapsedSeconds * clip.playbackRate;
    source.start(this.context.currentTime, clip.offsetSeconds + (clip.loop ? advanced % available : advanced));
    entry.source = source;
    source.stop(this.context.currentTime + clip.durationSeconds - entry.elapsedSeconds);
    source.onended = () => {
      if (entry.source === source) this.stop(clip.clipId);
    };
  }

  private elapsed(entry: PlayingClip): number {
    return entry.elapsedSeconds + (entry.source ? this.context.currentTime - entry.startedAt : 0);
  }
  private updateGain(entry: PlayingClip): void {
    if (entry.gain)
      scheduleAudioClipGain(
        entry.gain.gain,
        entry.clip,
        this.context.currentTime,
        this.elapsed(entry),
        entry.clip.muted ? 0 : entry.clip.volume * entry.clip.trackVolume * this.volume(entry.clip.category),
      );
  }
  refreshVolumes(): void {
    for (const entry of this.playing.values()) this.updateGain(entry);
  }
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    for (const entry of this.playing.values()) {
      if (paused) {
        entry.elapsedSeconds = this.elapsed(entry);
        if (entry.elapsedSeconds >= entry.clip.durationSeconds) this.stop(entry.clip.clipId);
        else this.disconnect(entry);
      } else this.start(entry);
    }
    if (paused) {
      this.releaseDevice?.();
      this.releaseDevice = undefined;
    }
  }
  private disconnect(entry: PlayingClip): void {
    const source = entry.source;
    entry.source = undefined;
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    entry.gain?.disconnect();
    entry.gain = undefined;
  }
  stop(id: string): void {
    const entry = this.playing.get(id);
    if (entry) this.disconnect(entry);
    this.playing.delete(id);
    entry?.finish();
    if (!this.playing.size) {
      this.releaseDevice?.();
      this.releaseDevice = undefined;
    }
  }
  stopAll(): void {
    this.generation++;
    for (const id of this.playing.keys()) this.stop(id);
  }
  snapshot(): StoryAudioClipSnapshot[] {
    return [...this.playing.values()].map((entry) => ({
      clip: { ...entry.clip },
      elapsedSeconds: this.elapsed(entry),
    }));
  }
  setCapture(destination?: AudioNode): void {
    for (const entry of this.playing.values()) {
      if (this.capture && entry.gain) entry.gain.disconnect(this.capture);
      if (destination && entry.gain) entry.gain.connect(destination);
    }
    this.capture = destination;
  }
  dispose(): void {
    this.lifetime.abort();
    this.stopAll();
    this.decoded.clear();
    this.pending.clear();
  }
}
