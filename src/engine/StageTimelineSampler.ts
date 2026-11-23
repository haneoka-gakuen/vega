import { StageFrameClock } from "../core/StageFrameClock";
import { delaySeconds } from "../core/time";
import type { StorySceneBackend } from "../rendering/StorySceneBackend";
import type { AdvCommand } from "../types/AdvRuntime";
import type { VegaPlayerHandle } from "../web-entry";
import { hasStageDialogue, paintStageDialogue, stageSubtitleText } from "./SubtitleOverlay";

type FrameSurface = ReturnType<NonNullable<StorySceneBackend["createFrameCapture"]>>;

/** A forward-running sample transport with its own player, clock, and silent mixer. */
export class StageTimelineSampler {
  private readonly controller = new AbortController();
  private readonly clock = new StageFrameClock(this.controller.signal);
  private surface?: FrameSurface;
  private playback?: Promise<void>;
  private restoreClock?: () => void;
  private failure?: { error: unknown };
  private position = 0;
  private disposed = false;

  constructor(
    private readonly handle: Pick<VegaPlayerHandle, "player" | "dispose">,
    private readonly mount: HTMLElement,
  ) {}

  start(command: AdvCommand, width: number, height: number, transparentBackground = false): void {
    const { player } = this.handle;
    const { clock, controller } = this;
    if (!player.SceneRoot.createFrameCapture) throw new Error("Timeline preview is unavailable in this renderer");
    this.restoreClock = player.beginFrameExport(clock);
    const audio = player.SoundManager.beginFrameExport(clock);
    this.surface = player.SceneRoot.createFrameCapture(
      { width, height, transparentBackground },
      {
        signal: controller.signal,
        nowSeconds: () => clock.nowSeconds(),
        hold: (resource) => clock.hold(resource),
        wait: (seconds, signal) => delaySeconds(seconds, signal ?? controller.signal, clock.scheduleDelay),
        playVideoAudio: (source, offset, rate) => audio.playVideo(source, offset, rate),
      },
    );
    player.setPreviewChoiceRoute([]);
    if (!player.Model.isAutoPlay) player.toggleAuto();
    player.resume();
    this.playback = player.executePreviewCommands([command], controller.signal).catch((error) => {
      if (!controller.signal.aborted) this.failure = { error };
    });
  }

  get seconds(): number {
    return this.position;
  }

  get subtitleText(): string {
    return stageSubtitleText(this.handle.player);
  }

  async sample(seconds: number, signal: AbortSignal): Promise<string> {
    return (await this.captureAt(seconds, signal)).toDataURL("image/webp", 0.88);
  }

  async captureAt(seconds: number, signal: AbortSignal, includeDialogue = true): Promise<HTMLCanvasElement> {
    const surface = this.surface;
    if (!surface || this.disposed || seconds < this.position) throw new Error("Timeline preview is unavailable");
    await this.clock.settle();
    while (this.position < seconds - 1e-9) {
      signal.throwIfAborted();
      const next = Math.min(seconds, this.position + 1 / 60);
      surface.advance(next - this.position);
      await this.clock.advanceTo(next);
      this.position = next;
      if (this.failure) throw this.failure.error;
    }
    if (this.failure) throw this.failure.error;
    signal.throwIfAborted();
    const error = this.handle.player.state.error;
    if (error) throw new Error(error);
    await surface.capture();
    if (!includeDialogue || !hasStageDialogue(this.handle.player)) return surface.canvas;
    const canvas = this.mount.ownerDocument.createElement("canvas");
    canvas.width = surface.canvas.width;
    canvas.height = surface.canvas.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Stage capture is unavailable");
    context.drawImage(surface.canvas, 0, 0);
    await paintStageDialogue(context, this.handle.player);
    return canvas;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    await this.playback;
    this.clock.close();
    this.surface?.dispose();
    this.handle.player.SoundManager.endFrameExport();
    this.restoreClock?.();
    try {
      await this.handle.dispose();
    } finally {
      this.mount.remove();
    }
  }
}
