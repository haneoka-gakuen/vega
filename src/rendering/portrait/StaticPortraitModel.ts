import type { AdvStaticPortraitPivot } from "../../types/AdvRuntime";
import type { StoryCharacterModel } from "../StoryCharacterModel";
import type { StoryResourceResolver } from "../StorySceneBackend";

export type StaticPortraitPivot = Readonly<AdvStaticPortraitPivot>;

export interface StaticPortraitModelOptions {
  readonly imageUrl: string;
  readonly resources: StoryResourceResolver;
  readonly signal?: AbortSignal;
  readonly pivot?: StaticPortraitPivot;
  readonly alt?: string;
  /** Episode-owned decoded image retained by the scene until teardown. */
  readonly decodedTemplate?: HTMLImageElement;
}

/**
 * Browser-native, dependency-free character model used by the default scene.
 */
export class StaticPortraitModel implements StoryCharacterModel {
  readonly format = "static-portrait";
  readonly source: string;
  readonly element: HTMLImageElement;
  private releaseSource: () => void = () => undefined;
  private disposed = false;

  private constructor(source: string, element: HTMLImageElement) {
    this.source = source;
    this.element = element;
  }

  get isOperational(): boolean {
    return !this.disposed;
  }

  static async create(options: StaticPortraitModelOptions): Promise<StaticPortraitModel> {
    if (typeof document === "undefined") {
      throw new Error("Static portraits require a browser document");
    }
    const resolved = options.decodedTemplate
      ? null
      : await options.resources.resolveRenderable(options.imageUrl, options.signal);
    const image = options.decodedTemplate
      ? (options.decodedTemplate.cloneNode(false) as HTMLImageElement)
      : document.createElement("img");
    image.className = "vega-stage__portrait";
    image.alt = options.alt ?? "";
    image.draggable = false;
    image.decoding = "async";
    image.style.cssText =
      "display:block;max-width:none;height:100%;width:auto;object-fit:contain;object-position:center bottom;pointer-events:none;user-select:none;";
    const pivotX = Number(options.pivot?.x);
    const pivotY = Number(options.pivot?.y);
    if (Number.isFinite(pivotX) || Number.isFinite(pivotY)) {
      image.style.transformOrigin = `${(Number.isFinite(pivotX) ? pivotX : 0.5) * 100}% ${
        (1 - (Number.isFinite(pivotY) ? pivotY : 0)) * 100
      }%`;
    }
    const sourceUrl = options.decodedTemplate?.currentSrc || options.decodedTemplate?.src || resolved?.url || "";
    const loaded = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        image.removeEventListener("load", done);
        image.removeEventListener("error", failed);
        options.signal?.removeEventListener("abort", aborted);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error(`Static portrait could not be decoded: ${options.imageUrl}`));
      };
      const aborted = () => {
        cleanup();
        const error = new Error("Static portrait loading was aborted");
        error.name = "AbortError";
        reject(error);
      };
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", failed, { once: true });
      options.signal?.addEventListener("abort", aborted, { once: true });
      image.src = sourceUrl;
      if (options.signal?.aborted) aborted();
      else if (image.complete) {
        if (image.naturalWidth > 0) done();
        else failed();
      }
    });
    try {
      await loaded;
      if (typeof image.decode === "function") await image.decode();
    } catch (error) {
      resolved?.release();
      throw error;
    }
    const model = new StaticPortraitModel(options.imageUrl, image);
    model.releaseSource = resolved?.release ?? (() => undefined);
    return model;
  }

  setPaused(paused: boolean): void {
    this.element.dataset.paused = String(paused);
  }

  setPlaybackSpeed(rate: number): void {
    this.element.dataset.playbackSpeed = String(rate);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.remove();
    this.element.removeAttribute("src");
    this.releaseSource();
    this.releaseSource = () => undefined;
  }
}
