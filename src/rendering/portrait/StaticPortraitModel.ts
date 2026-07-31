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
    const resolved = await options.resources.resolveRenderable(options.imageUrl, options.signal);
    const image = document.createElement("img");
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
    const loaded = new Promise<void>((resolve, reject) => {
      const done = () => {
        image.removeEventListener("load", done);
        image.removeEventListener("error", failed);
        resolve();
      };
      const failed = () => {
        image.removeEventListener("load", done);
        image.removeEventListener("error", failed);
        reject(new Error(`Static portrait could not be decoded: ${options.imageUrl}`));
      };
      image.addEventListener("load", done, { once: true });
      image.addEventListener("error", failed, { once: true });
    });
    image.src = resolved.url;
    try {
      await loaded;
    } catch (error) {
      resolved.release();
      throw error;
    }
    const model = new StaticPortraitModel(options.imageUrl, image);
    model.releaseSource = resolved.release;
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
