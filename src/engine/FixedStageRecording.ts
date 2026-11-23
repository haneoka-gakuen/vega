import type { AdvPlayer } from "../core/AdvPlayer";
import { StageFrameClock } from "../core/StageFrameClock";
import { delaySeconds } from "../core/time";
import type { StorySceneBackend } from "../rendering/StorySceneBackend";
import type { OfflineStageAudio } from "../sound/OfflineStageAudio";
import { formatVegaSubRip } from "@haneoka/vega-protocol";
import { beginFixedStageEncoding, type FixedStageEncoder, type StageVideoOptions } from "./StageEncoding";
import { paintStageDialogue, stageSubtitleText } from "./SubtitleOverlay";

type FrameSurface = ReturnType<NonNullable<StorySceneBackend["createFrameCapture"]>>;
type FrameProgress = (frame: number, seconds: number, phase: "render" | "mix") => void;

/** Renders and encodes each output frame under backpressure from the encoder. */
export class FixedStageRecording {
  private readonly controller = new AbortController();
  private readonly finalization = new AbortController();
  private readonly clock = new StageFrameClock(this.controller.signal);
  private readonly cues: { text: string; start: number; end: number }[] = [];
  private surface?: FrameSurface;
  private encoder?: FixedStageEncoder;
  private audio?: OfflineStageAudio;
  private rendered?: Promise<void>;
  private result?: Blob;
  private stopping?: Promise<Blob>;
  private requestedStop = false;
  private frames = 0;

  private constructor(
    private readonly player: AdvPlayer,
    private readonly options: StageVideoOptions,
    private readonly progress: FrameProgress,
  ) {}

  static async start(
    player: AdvPlayer,
    options: StageVideoOptions & { burnSubtitles?: boolean },
    progress: FrameProgress,
  ): Promise<FixedStageRecording> {
    if (!player.SceneRoot.createFrameCapture) throw new Error("Fixed-frame export is unavailable in this renderer");
    const recording = new FixedStageRecording(player, options, progress);
    try {
      recording.surface = player.SceneRoot.createFrameCapture(options, {
        signal: recording.controller.signal,
        nowSeconds: () => recording.clock.nowSeconds(),
        hold: (resource) => recording.clock.hold(resource),
        wait: (seconds, signal) =>
          delaySeconds(seconds, signal ?? recording.controller.signal, recording.clock.scheduleDelay),
        playVideoAudio: (source, offset, rate) => recording.audio?.playVideo(source, offset, rate) ?? (() => {}),
      });
      recording.encoder = await beginFixedStageEncoding(
        recording.surface.canvas,
        options,
        options.burnSubtitles ? (context) => paintStageDialogue(context, player) : undefined,
      );
      return recording;
    } catch (error) {
      await recording.dispose();
      throw error;
    }
  }

  play(): Promise<void> {
    return (this.rendered ??= this.render());
  }

  private async render(): Promise<void> {
    const { player, surface, encoder, options, clock } = this;
    if (!surface || !encoder) throw new Error("Fixed-frame export was closed");
    const restore = player.beginFrameExport(clock);
    const restoreAuto = !player.Model.isAutoPlay;
    let playback: Promise<void> | undefined;
    try {
      this.audio = player.SoundManager.beginFrameExport(clock);
      if (restoreAuto) player.toggleAuto();
      let finished = false;
      let failed: unknown;
      playback = player.play();
      void playback.then(
        () => {
          finished = true;
        },
        (error) => {
          failed = error;
          finished = true;
        },
      );
      for (let index = 0; !this.requestedStop && !clock.signal.aborted; index++) {
        const time = index / options.fps;
        if (time > 1800) throw new Error("Recording size limit reached");
        if (index) surface.advance(1 / options.fps);
        await clock.advanceTo(time);
        if (failed) throw failed;
        if (player.state.error) throw new Error(player.state.error);
        if (player.state.choices.visible) throw new Error("Choose the export route before rendering");
        if (finished && index > 0) break;
        if (options.container !== "wav") await surface.capture();
        this.subtitle(time);
        await encoder.add(time);
        this.frames++;
        if (this.frames === 1 || this.frames % 8 === 0) this.progress(this.frames, this.frames / options.fps, "render");
        if (finished) break;
      }
    } finally {
      this.controller.abort();
      await playback?.catch(() => undefined);
      clock.close();
      player.SoundManager.endFrameExport();
      restore();
      if (restoreAuto && player.Model.isAutoPlay) player.toggleAuto();
    }
  }

  private subtitle(time: number): void {
    const text = stageSubtitleText(this.player);
    const previous = this.cues.at(-1);
    if (previous?.text === text) return;
    if (previous) previous.end = time;
    this.cues.push({ text, start: time, end: time });
  }

  get subtitles(): string {
    return formatVegaSubRip(
      this.cues.map((cue, index) =>
        index === this.cues.length - 1 ? { ...cue, end: this.frames / this.options.fps } : cue,
      ),
    );
  }

  stop(): Promise<Blob> {
    this.requestedStop = true;
    return (this.stopping ??= (async () => {
      try {
        await this.rendered;
        if (!this.encoder || !this.frames) throw new Error("Video recording produced no frames");
        const duration = this.frames / this.options.fps;
        this.progress(this.frames, duration, "mix");
        const signal = this.finalization.signal;
        signal.throwIfAborted();
        const audio =
          this.options.container === "gif" || this.options.container === "apng"
            ? undefined
            : await this.audio?.render(duration, signal);
        signal.throwIfAborted();
        const result = await this.encoder.finish(duration, audio);
        signal.throwIfAborted();
        return (this.result = result);
      } catch (error) {
        await this.encoder?.cancel?.().catch(() => undefined);
        throw error;
      } finally {
        this.surface?.dispose();
        this.surface = undefined;
      }
    })());
  }

  async read(offset: number): Promise<string> {
    if (!this.result) throw new Error("Recording is still running");
    const bytes = new Uint8Array(await this.result.slice(offset, offset + 192 * 1024).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  cancel(): void {
    this.requestedStop = true;
    this.controller.abort();
    this.finalization.abort();
  }

  async dispose(): Promise<void> {
    this.cancel();
    await this.rendered?.catch(() => undefined);
    if (this.stopping) await this.stopping.catch(() => undefined);
    else await this.encoder?.cancel?.().catch(() => undefined);
    this.clock.close();
    this.surface?.dispose();
    this.surface = undefined;
    this.result = undefined;
    this.cues.length = 0;
  }
}
