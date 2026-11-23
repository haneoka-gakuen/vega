import type { StageFrameClock } from "../core/StageFrameClock";
import { decodeStoryVideoAudio } from "./VideoAudio";
import type { StoryResourceResolver } from "../resources/StoryResourcePort";
import type { AdvSoundCategory, AdvSoundDescriptor, WaitForVoicePlaybackOptions } from "./AdvSoundManager";
import {
  audioClipPlayableDuration,
  audioClipSourcePosition,
  scheduleAudioClipGain,
  type StoryAudioClip,
} from "./AudioClipPlayer";
import type { VegaVoiceAnalyzer, VegaVoicePcmFrame } from "./VoiceAnalysis";

const sampleRate = 48000;

interface GainPoint {
  readonly time: number;
  readonly target: number;
  readonly duration: number;
}

export interface OfflineStageSound {
  readonly offline: true;
  readonly playId: number;
  readonly category: AdvSoundCategory;
  readonly sound?: AdvSoundDescriptor;
  readonly clip?: StoryAudioClip;
  readonly start: number;
  offset: number;
  readonly rate: number;
  readonly loop: boolean;
  readonly points: GainPoint[];
  readonly analyzer: VegaVoiceAnalyzer | null;
  readonly done: Promise<boolean>;
  readonly isPlaying: () => boolean;
  readonly settle: (natural: boolean) => void;
  buffer?: AudioBuffer;
  gain: number;
  end: number;
  timer?: number;
  autoStop?: number;
}

export class OfflineStageAudio {
  private readonly decoder = new OfflineAudioContext(2, 1, sampleRate);
  private readonly sources = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly entries = new Map<number, OfflineStageSound>();
  private sequence = 0;
  private bytes = 0;

  constructor(
    private readonly clock: StageFrameClock,
    private readonly resources?: StoryResourceResolver,
  ) {}

  prepare(url: string, video = false): Promise<AudioBuffer | undefined> {
    const key = `${video ? "video" : "audio"}:${url}`;
    let decoded = this.sources.get(key);
    if (!decoded) {
      decoded = this.clock.hold(
        (async () => {
          const signal = this.clock.signal;
          const bytes = this.resources?.canLoad(url)
            ? await this.resources.load(url, signal)
            : await fetch(url, { signal }).then(async (response) => {
                if (!response.ok) throw new Error(`Cannot load export audio (${response.status})`);
                return new Uint8Array(await response.arrayBuffer());
              });
          if (bytes.byteLength > 512 * 1024 * 1024) throw new Error("Recording size limit reached");
          const buffer = video
            ? await decodeStoryVideoAudio(bytes, this.decoder, signal)
            : await this.decoder.decodeAudioData(new Uint8Array(bytes).buffer);
          signal.throwIfAborted();
          if (!buffer) return;
          this.bytes += buffer.length * buffer.numberOfChannels * 4;
          if (this.bytes > 512 * 1024 * 1024) throw new Error("Recording size limit reached");
          return buffer;
        })(),
      );
      this.sources.set(key, decoded);
    }
    return decoded;
  }

  playVideo(url: string, offset: number, rate: number): () => void {
    const entry = this.play({ url, category: "Se", gain: 1, offset, rate, video: true });
    return () => this.stop(entry);
  }

  play(options: {
    url: string;
    category: AdvSoundCategory;
    gain: number;
    sound?: AdvSoundDescriptor;
    clip?: StoryAudioClip;
    offset?: number;
    fade?: number;
    loop?: boolean;
    rate?: number;
    video?: boolean;
  }): OfflineStageSound {
    const start = this.clock.nowSeconds();
    const clip = options.clip;
    let resolve!: (natural: boolean) => void;
    const done = new Promise<boolean>((done) => {
      resolve = done;
    });
    const entry: OfflineStageSound = {
      offline: true,
      playId: ++this.sequence,
      category: options.category,
      sound: options.sound,
      clip,
      start,
      offset: Math.max(0, clip?.offsetSeconds ?? options.offset ?? 0),
      rate: clip?.playbackRate ?? options.rate ?? 1,
      loop: clip?.loop ?? options.loop === true,
      gain: options.fade ? 0 : options.gain,
      end: clip ? start + clip.durationSeconds : Infinity,
      points: [],
      analyzer: options.category === "Voice" ? this.analyzer(() => entry) : null,
      done,
      isPlaying: () => this.clock.nowSeconds() < entry.end,
      settle: (natural) => resolve(natural),
    };
    this.entries.set(entry.playId, entry);
    if (options.fade) this.changeGain(entry, options.gain, options.fade);
    // Arm the natural completion before releasing the decode barrier.
    this.clock.hold(
      this.prepare(options.url, options.video).then((buffer) => {
        if (!buffer) {
          entry.end = start;
          entry.settle(true);
          return;
        }
        entry.buffer = buffer;
        if (clip) {
          entry.offset = audioClipSourcePosition(clip, buffer.duration, 0);
          entry.end = Math.min(entry.end, start + audioClipPlayableDuration(clip, buffer.duration));
        } else if (entry.loop && buffer.duration > 0) entry.offset %= buffer.duration;
        else if (!entry.loop)
          entry.end = Math.min(entry.end, start + Math.max(0, buffer.duration - entry.offset) / entry.rate);
        this.armCompletion(entry, true);
      }),
    );
    return entry;
  }

  private analyzer(entry: () => OfflineStageSound): VegaVoiceAnalyzer {
    const samplePcm = (): VegaVoicePcmFrame | null => {
      const sound = entry();
      const buffer = sound.buffer;
      const clock = this.clock.nowSeconds();
      if (!buffer || clock < sound.start || clock >= sound.end) return null;
      const time = (clock - sound.start) * sound.rate;
      const loopStart = sound.clip?.offsetSeconds ?? 0;
      const length = buffer.duration - loopStart;
      if (length <= 0) return null;
      return {
        sourceKey: sound.playId,
        channelData: buffer.getChannelData(0),
        sampleRate: buffer.sampleRate,
        samplePosition: Math.floor(
          (sound.loop ? loopStart + ((sound.offset - loopStart + time) % length) : sound.offset + time) *
            buffer.sampleRate,
        ),
      };
    };
    return {
      samplePcm,
      sampleRms() {
        const pcm = samplePcm();
        if (!pcm) return 0;
        let sum = 0;
        const size = Math.min(256, pcm.samplePosition + 1);
        for (let index = pcm.samplePosition - size + 1; index <= pcm.samplePosition; index++) {
          const value = pcm.channelData[index] ?? 0;
          sum += value ** 2;
        }
        return Math.sqrt(sum / size);
      },
      sampleSpectrum: () => null,
      dispose() {},
    };
  }

  private armCompletion(entry: OfflineStageSound, natural: boolean): void {
    if (entry.timer !== undefined) this.clock.cancel(entry.timer);
    const delay = entry.end - this.clock.nowSeconds();
    if (!Number.isFinite(delay)) return;
    if (delay <= 0 || this.clock.signal.aborted) entry.settle(natural);
    else entry.timer = this.clock.schedule(delay, () => entry.settle(natural));
  }

  changeGain(entry: OfflineStageSound, target: number, duration = 0): void {
    entry.points.push({ time: this.clock.nowSeconds(), target, duration: Math.max(0, duration) });
  }

  changeCategory(category: AdvSoundCategory, gain: (entry: OfflineStageSound) => number, duration = 0): void {
    for (const entry of this.entries.values()) {
      if (entry.category === category && entry.isPlaying()) this.changeGain(entry, gain(entry), duration);
    }
  }

  stop(entry: OfflineStageSound, fade = 0): void {
    if (!entry.isPlaying()) return;
    if (fade > 0) this.changeGain(entry, 0, fade);
    entry.end = Math.min(entry.end, this.clock.nowSeconds() + fade);
    this.armCompletion(entry, false);
  }

  stopCategory(category: AdvSoundCategory, fade = 0, ids?: ReadonlySet<number>): void {
    for (const entry of this.entries.values()) {
      if (entry.category === category && (!ids || ids.has(entry.playId))) this.stop(entry, fade);
    }
  }

  stopSoundEffect(id: number, fade = 0): void {
    for (const entry of this.entries.values()) {
      if (entry.category === "Se" && (!id || Number(entry.sound?.soundId ?? entry.sound?.id) === id))
        this.stop(entry, fade);
    }
  }

  async waitForVoices(ids: readonly number[], options: WaitForVoicePlaybackOptions): Promise<boolean> {
    const signals = [this.clock.signal, options.signal, options.scopeSignal].filter(
      (signal): signal is AbortSignal => !!signal,
    );
    if (signals.some((signal) => signal.aborted)) return false;
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        for (const signal of signals) signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => finish(false);
      for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
      void Promise.all(ids.map((id) => this.entries.get(id)?.done ?? false)).then((states) => {
        finish(states.every(Boolean) && (options.isScopeCurrent?.() ?? true));
      });
    });
  }

  async render(duration: number, signal: AbortSignal): Promise<AudioBuffer> {
    signal.throwIfAborted();
    const length = Math.max(1, Math.round(duration * sampleRate));
    if (length * 8 > 256 * 1024 * 1024) throw new Error("Recording size limit reached");
    const context = new OfflineAudioContext(2, length, sampleRate);
    for (const entry of this.entries.values()) {
      const buffer = entry.buffer;
      const end = Math.min(duration, entry.end);
      if (!buffer || end <= entry.start || buffer.duration <= entry.offset || entry.clip?.muted) continue;
      const source = context.createBufferSource(),
        gain = context.createGain();
      source.buffer = buffer;
      source.loop = entry.loop;
      source.loopStart = entry.clip?.offsetSeconds ?? 0;
      source.loopEnd = buffer.duration;
      source.playbackRate.value = entry.rate;
      if (entry.clip) {
        const envelope = context.createGain();
        scheduleAudioClipGain(envelope.gain, entry.clip, entry.start, 0, 1);
        source.connect(envelope);
        envelope.connect(gain);
      } else source.connect(gain);
      gain.connect(context.destination);
      let current = { start: entry.start, initial: entry.gain, end: entry.start, target: entry.gain };
      gain.gain.setValueAtTime(entry.gain, entry.start);
      for (const point of entry.points) {
        if (point.time >= end) break;
        const ratio =
          current.end > current.start
            ? Math.max(0, Math.min(1, (point.time - current.start) / (current.end - current.start)))
            : 1;
        const value = current.initial + (current.target - current.initial) * ratio;
        gain.gain.cancelScheduledValues(point.time);
        if (current.end > point.time) gain.gain.linearRampToValueAtTime(value, point.time);
        else gain.gain.setValueAtTime(value, point.time);
        if (point.duration) gain.gain.linearRampToValueAtTime(point.target, point.time + point.duration);
        else gain.gain.setValueAtTime(point.target, point.time);
        current = { start: point.time, initial: value, end: point.time + point.duration, target: point.target };
      }
      source.start(entry.start, entry.offset);
      source.stop(end);
    }
    return new Promise<AudioBuffer>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void context
        .startRendering()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
