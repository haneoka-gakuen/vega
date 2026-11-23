import { MAX_STAGE_CLIP_VOLUME, type PropertyAnimationClip } from "@haneoka/vega-protocol";
import { samplePropertyAnimation } from "../rendering/PropertyAnimation";
import type { StoryResourceResolver } from "../resources/StoryResourcePort";
import type { VegaVoiceAnalysisSource, VegaVoicePcmFrame } from "./VoiceAnalysis";
import { decodeStoryVideoAudio } from "./VideoAudio";

export interface StoryAudioClip {
  clipId: string;
  source: string;
  sourceKind?: "audio" | "video";
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
  lipSyncTarget?: string;
  sourceWindow?: { offsetSeconds: number; durationSeconds: number; playbackRate: number };
  gainAnimation?: PropertyAnimationClip;
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
  const animation = clip.gainAnimation;
  const volume = animation
    ? (samplePropertyAnimation(animation, Math.min(elapsed, animation.durationSeconds)).volume ?? 1)
    : 1;
  const window = clip.sourceWindow;
  if (window) elapsed = window.offsetSeconds + elapsed * window.playbackRate;
  const into = clip.fadeInSeconds > 0 ? elapsed / clip.fadeInSeconds : 1;
  const out =
    clip.fadeOutSeconds > 0 ? ((window?.durationSeconds ?? clip.durationSeconds) - elapsed) / clip.fadeOutSeconds : 1;
  return Math.max(0, Math.min(1, into, out)) * Math.max(0, Math.min(MAX_STAGE_CLIP_VOLUME, volume));
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
  const window = clip.sourceWindow;
  const duration = window?.durationSeconds ?? clip.durationSeconds;
  const points = [clip.fadeInSeconds, duration - clip.fadeOutSeconds, duration];
  if (clip.fadeInSeconds + clip.fadeOutSeconds > duration)
    points.push((duration * clip.fadeInSeconds) / (clip.fadeInSeconds + clip.fadeOutSeconds));
  const times = window ? points.map((time) => (time - window.offsetSeconds) / window.playbackRate) : points;
  const animation = clip.gainAnimation;
  const track = animation?.tracks[0];
  if (animation && track) {
    const source = animation.sourceWindow;
    const keys = track.points.map(
      (point) => (point.timeSeconds - (source?.offsetSeconds ?? 0)) / (source?.playbackRate ?? 1),
    );
    const step = Math.max(1 / 60, clip.durationSeconds / 4096);
    const samples = Array.from(
      { length: Math.ceil((clip.durationSeconds - elapsed) / step) },
      (_, i) => elapsed + step * (i + 1),
    );
    times.push(animation.durationSeconds, ...keys, ...samples);
    const discontinuities = new Set(keys.filter((_, index) => track.points[index]?.ease === "hold"));
    for (const time of [...new Set([...times, clip.durationSeconds])]
      .filter((time) => time > elapsed && time <= clip.durationSeconds)
      .sort((a, b) => a - b)) {
      const discontinuity = discontinuities.has(time);
      gain.linearRampToValueAtTime(
        volume * audioClipEnvelope(clip, discontinuity ? Math.max(elapsed, time - 1e-8) : time),
        at + time - elapsed,
      );
      if (discontinuity) gain.setValueAtTime(volume * audioClipEnvelope(clip, time), at + time - elapsed);
    }
    return;
  }
  for (const time of [...new Set([...times, clip.durationSeconds])]
    .filter((time) => time > elapsed && time <= clip.durationSeconds)
    .sort((a, b) => a - b))
    gain.linearRampToValueAtTime(volume * audioClipEnvelope(clip, time), at + time - elapsed);
}

/** Position in decoded media, including the original loop boundary and an instance cut-in. */
export function audioClipSourcePosition(clip: StoryAudioClip, bufferSeconds: number, elapsed = 0): number {
  const window = clip.sourceWindow;
  const offset = (elapsed + (window ? window.offsetSeconds / window.playbackRate : 0)) * clip.playbackRate;
  return clip.offsetSeconds + (clip.loop ? offset % (bufferSeconds - clip.offsetSeconds) : offset);
}

export function audioClipPlayableDuration(clip: StoryAudioClip, bufferSeconds: number): number {
  if (clip.offsetSeconds >= bufferSeconds) return 0;
  return clip.loop
    ? clip.durationSeconds
    : Math.max(
        0,
        Math.min(
          clip.durationSeconds,
          (bufferSeconds - audioClipSourcePosition(clip, bufferSeconds)) / clip.playbackRate,
        ),
      );
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

  private async decode(source: string, sourceKind?: "audio" | "video"): Promise<AudioBuffer> {
    const key = `${sourceKind === "video" ? "video" : "audio"}:${source}`;
    const found = this.decoded.get(key);
    if (found) {
      this.decoded.delete(key);
      this.decoded.set(key, found);
      return found;
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = (async () => {
        const bytes = this.resources?.canLoad(source)
          ? await this.resources.load(source, this.lifetime.signal)
          : new Uint8Array(await (await fetch(source, { signal: this.lifetime.signal })).arrayBuffer());
        let buffer: AudioBuffer;
        try {
          buffer =
            sourceKind === "video"
              ? ((await decodeStoryVideoAudio(bytes, this.context, this.lifetime.signal)) ??
                this.context.createBuffer(1, 1, 48000))
              : await this.context.decodeAudioData(new Uint8Array(bytes).buffer);
        } catch (error) {
          throw new Error("Audio file cannot be decoded", { cause: error });
        }
        this.lifetime.signal.throwIfAborted();
        this.decoded.set(key, buffer);
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
      this.pending.set(key, pending);
      void pending.finally(() => this.pending.delete(key)).catch(() => {});
    }
    return pending;
  }

  async prepare(clip: StoryAudioClip): Promise<void> {
    await this.decode(clip.source, clip.sourceKind);
  }

  async play(
    clip: StoryAudioClip,
    elapsedSeconds = 0,
    signal?: AbortSignal,
    onVoice?: (source: VegaVoiceAnalysisSource, durationSeconds: number) => void,
  ): Promise<void> {
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
      clip.volume > MAX_STAGE_CLIP_VOLUME ||
      clip.trackVolume > 1
    )
      throw new TypeError("Invalid audio clip");
    if (signal?.aborted) return;
    const generation = this.generation;
    const buffer = await this.decode(clip.source, clip.sourceKind);
    if (generation !== this.generation || this.lifetime.signal.aborted || signal?.aborted) return;
    if (clip.offsetSeconds >= buffer.duration) throw new RangeError("Audio trim starts after the source ends");
    this.stop(clip.clipId);
    const duration = audioClipPlayableDuration(clip, buffer.duration);
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
      if (onVoice) onVoice(this.voiceAnalysis(entry), duration - elapsedSeconds);
      await done;
    } catch (error) {
      this.stop(clip.clipId);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private sourceTime(entry: PlayingClip, elapsed: number): number {
    const { clip } = entry;
    return audioClipSourcePosition(clip, entry.buffer.duration, elapsed);
  }

  private voiceAnalysis(entry: PlayingClip): VegaVoiceAnalysisSource {
    const isPlaying = () => Boolean(entry.source && this.playing.get(entry.clip.clipId) === entry);
    const samplePcm = (): VegaVoicePcmFrame | null => {
      if (!isPlaying()) return null;
      const { buffer } = entry;
      return {
        sourceKey: entry.clip.clipId,
        channelData: buffer.getChannelData(0),
        sampleRate: buffer.sampleRate,
        samplePosition: this.sourceTime(entry, this.elapsed(entry)) * buffer.sampleRate,
      };
    };
    const player = this;
    return {
      analyzer: {
        samplePcm,
        sampleMotionSyncPcm: samplePcm,
        sampleRms: () => 0,
        sampleSpectrum: () => null,
        dispose() {},
      },
      isPlaying,
      howl: { playing: isPlaying },
      get playbackStarted() {
        return isPlaying();
      },
      get playbackSettled() {
        return player.playing.get(entry.clip.clipId) !== entry;
      },
    };
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
    source.start(this.context.currentTime, this.sourceTime(entry, entry.elapsedSeconds));
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
