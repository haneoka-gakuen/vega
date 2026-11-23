import type { AdvPlayer } from "../core/AdvPlayer";
import { formatVegaSubRip } from "@haneoka/vega-protocol";
import { paintStageDialogue, stageSubtitleText } from "./SubtitleOverlay";
import {
  beginAudioEncoding,
  beginFrameEncoding,
  beginStreamEncoding,
  type StageEncoding,
  type StageVideoOptions,
} from "./StageEncoding";

/** Records the selected backend and the same audio bus used during playback. */
export class StageRecording {
  private readonly startedAt = performance.now();
  private readonly cues: { text: string; start: number; end: number }[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly restoreAuto: boolean;
  private result?: Blob;
  private stopping?: Promise<Blob>;

  static async start(
    player: AdvPlayer,
    options: StageVideoOptions & { autoAdvance?: boolean; burnSubtitles?: boolean },
  ): Promise<StageRecording> {
    const capture = options.container === "wav" ? undefined : player.SceneRoot.createVideoCapture?.(options);
    if (options.container !== "wav" && !capture) throw new Error("Video recording unavailable");
    try {
      const audio = player.SoundManager.beginAudioCapture();
      const audioTrack = audio.getAudioTracks()[0];
      if (!capture) {
        const encoding = await beginAudioEncoding(audioTrack);
        return new StageRecording(player, encoding, undefined, options.autoAdvance === true);
      }
      const caption = options.burnSubtitles
        ? (context: CanvasRenderingContext2D) => paintStageDialogue(context, player)
        : undefined;
      const encoder = capture.canvas
        ? await beginFrameEncoding(capture.canvas, audioTrack, options, caption).catch((error: unknown) => {
            if (caption || options.container === "apng" || options.container === "gif" || options.transparentBackground)
              throw error;
            return undefined;
          })
        : undefined;
      if (caption && !encoder) throw new Error("Subtitled recording is unavailable");
      if (options.transparentBackground && !encoder) throw new Error("Transparent recording is unavailable");
      if (options.container === "apng" && !encoder) throw new Error("Animated PNG export is unavailable");
      const encoding =
        encoder ??
        beginStreamEncoding(new MediaStream([...capture.stream.getVideoTracks(), ...audio.getAudioTracks()]), options);
      return new StageRecording(player, encoding, capture, options.autoAdvance === true);
    } catch (error) {
      capture?.dispose();
      player.SoundManager.endAudioCapture();
      throw error;
    }
  }

  private constructor(
    private readonly player: AdvPlayer,
    private readonly encoding: StageEncoding,
    private readonly capture: { dispose(): void } | undefined,
    autoAdvance: boolean,
  ) {
    this.restoreAuto = autoAdvance && !player.Model.isAutoPlay;
    if (this.restoreAuto) player.toggleAuto();
    this.timer = setInterval(() => this.subtitle(), 40);
    this.subtitle();
  }

  private subtitle(): void {
    const text = stageSubtitleText(this.player);
    const time = (performance.now() - this.startedAt) / 1000;
    const previous = this.cues.at(-1);
    if (previous) previous.end = time;
    if (previous?.text !== text) this.cues.push({ text, start: time, end: time });
  }

  stop(): Promise<Blob> {
    return (this.stopping ??= (async () => {
      clearInterval(this.timer);
      this.subtitle();
      try {
        return (this.result = await this.encoding.stop());
      } finally {
        this.capture?.dispose();
        this.player.SoundManager.endAudioCapture();
        if (this.restoreAuto && this.player.Model.isAutoPlay) this.player.toggleAuto();
      }
    })());
  }

  get subtitles(): string {
    const duration = this.encoding.durationSeconds;
    if (duration === undefined) return formatVegaSubRip(this.cues);
    return formatVegaSubRip(
      this.cues.filter((cue) => cue.start < duration).map((cue) => ({ ...cue, end: Math.min(cue.end, duration) })),
    );
  }

  async read(offset: number): Promise<string> {
    if (!this.result) throw new Error("Recording is still running");
    const bytes = new Uint8Array(await this.result.slice(offset, offset + 192 * 1024).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async dispose(): Promise<void> {
    await this.stop().catch(() => {});
    this.result = undefined;
    this.cues.length = 0;
  }
}
