import type {
  AdvBackgroundEntry,
  AdvCommand,
  AdvEffectEntry,
  AdvFocusDataRow,
  AdvFrameEntry,
  AdvPlayerState,
  AdvPostEffectEntry,
  AdvRuleTransitionEntry,
  AdvRuntimeConfig,
  AdvStillEntry,
  AdvVideoEntry,
} from "../../types/AdvRuntime";
import { advCharacterExpressions, advCharacterMotions } from "../../types/AdvRuntime";
import { lerp, resolveEase, tween } from "../../core/easing";
import { StaticPortraitModel } from "../portrait/StaticPortraitModel";
import type { StoryCharacterModel, StoryCharacterPresentation, StoryCharacterProvider } from "../StoryCharacterModel";
import type {
  StoryCameraState,
  StoryCharacterHandle,
  StoryCharacterPreloadRequest,
  StoryPoint2,
  StoryPoint3,
  StoryResourceResolver,
  StorySceneBackend,
} from "../StorySceneBackend";
import { createAdvDotweenShakePath, sampleAdvDotweenShake } from "../neutral/AdvDotweenShake";
import {
  STORY_SCENE_SEEK_SNAPSHOT_VERSION,
  type AdvStorySceneSeekSnapshot,
  type SeekSnapshotSafety,
} from "../neutral/StorySceneSnapshot";

interface CharacterRecord extends StoryCharacterHandle {
  readonly identity: string;
  readonly controllerIdentity: string;
  readonly provider: StoryCharacterProvider | null;
  readonly compilationOnly: boolean;
  readonly model: StoryCharacterModel;
  readonly host: HTMLDivElement;
  readonly sourceEntry: Record<string, unknown>;
  alpha: number;
  brightness: number;
  paused: boolean;
  worldPosition: StoryPoint3 | null;
  offset: StoryPoint3;
  angle: number;
  bodyAngle: number;
  lookX: number;
  lookY: number;
  lookEnabled: boolean;
  lookTargetName: string;
  blurIntensity: number;
  currentMotionName: string;
  currentMotionFadeInSeconds: number;
  currentExpressionName: string;
  currentExpressionFadeInSeconds: number;
  pendingPausedMotion: { readonly name: string; readonly fadeInSeconds: number } | null;
  pendingPausedExpression: { readonly name: string; readonly fadeInSeconds: number } | null;
  rimLight: {
    enabled: boolean;
    color: unknown;
    shadowIntensity: number;
  };
}

interface PendingCharacterRecord extends StoryCharacterHandle {
  readonly token: number;
  readonly identity: string;
  controllerIdentity: string;
  readonly provider: StoryCharacterProvider | null;
  readonly compilationOnly: boolean;
  alpha: number;
  brightness: number;
  paused: boolean;
  worldPosition: StoryPoint3 | null;
  offset: StoryPoint3;
  angle: number;
  bodyAngle: number;
  lookX: number;
  lookY: number;
  lookEnabled: boolean;
  lookTargetName: string;
  blurIntensity: number;
  currentMotionName: string;
  currentMotionFadeInSeconds: number;
  currentExpressionName: string;
  currentExpressionFadeInSeconds: number;
  pendingPausedMotion: { readonly name: string; readonly fadeInSeconds: number } | null;
  pendingPausedExpression: { readonly name: string; readonly fadeInSeconds: number } | null;
  rimLight: {
    enabled: boolean;
    color: unknown;
    shadowIntensity: number;
  };
}

interface MediaLease {
  readonly url: string;
  release(): void;
}

interface PreloadedVideo {
  readonly element: HTMLVideoElement;
  readonly lease: MediaLease;
}

interface PreloadedImage {
  readonly template: HTMLImageElement;
  readonly lease: MediaLease;
}

interface PreloadedCharacter {
  readonly identity: string;
  readonly target: string;
  readonly provider: StoryCharacterProvider;
  readonly sourceEntry: Record<string, unknown>;
  readonly model: StoryCharacterModel;
  readonly host: HTMLDivElement;
}

interface CommandEffectRecord {
  readonly key: string;
  readonly asset: AdvEffectEntry | null;
  readonly options: Readonly<Record<string, unknown>>;
  readonly element: HTMLDivElement;
}

interface GenericDomSeekState {
  readonly kind: "vega-generic-dom-v1";
  readonly commandPostEffect: unknown;
  readonly stageEnvironmentIndex: number;
  readonly stageLightIndex: number;
  readonly stagePostIndex: number;
  readonly stageParticleIndex: number;
  readonly backgroundBrightness?: number;
  readonly backgroundBlurIntensity?: number;
  readonly characterPriorityOrder?: readonly number[];
  readonly characters?: Readonly<
    Record<
      string,
      {
        readonly controllerIdentity?: string;
        readonly blurIntensity: number;
        readonly currentMotionName: string;
        readonly currentMotionFadeInSeconds: number;
        readonly currentExpressionName: string;
        readonly currentExpressionFadeInSeconds: number;
        readonly rimLight: {
          readonly enabled: boolean;
          readonly color: unknown;
          readonly shadowIntensity: number;
        };
      }
    >
  >;
  readonly commandEffects: readonly {
    readonly key: string;
    readonly asset: AdvEffectEntry | null;
    readonly options: Readonly<Record<string, unknown>>;
  }[];
}

export interface GenericStorySceneOptions {
  /**
   * Ordered host-provided character adapters. The first provider that supports
   * an entry owns its model lifecycle. Vega's static portrait fallback is used
   * only when no provider accepts the entry.
   */
  readonly characterProviders?: readonly StoryCharacterProvider[];
}

const clamp = (value: unknown, minimum = 0, maximum = 1): number => {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
};

const finite = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const firstString = (...values: unknown[]): string =>
  values.map((value) => String(value ?? "").trim()).find(Boolean) ?? "";

const imageSource = (entry: unknown): string => {
  const source = record(entry);
  const runtime = record(source.runtime);
  const candidate = firstString(
    runtime.imageUrl,
    source.imageUrl,
    source.portraitUrl,
    runtime.modelUrl,
    source.model,
    source.modelUrl,
    source.url,
    runtime.source,
    runtime.model,
  );
  return candidate;
};

const backgroundSource = (entry: unknown): string => {
  if (typeof entry === "string") return entry.trim();
  const source = record(entry);
  return firstString(source.url, source.src, source.source, source.imageUrl, record(source.runtime).imageUrl);
};

const colorCss = (value: unknown, fallback = "rgb(0 0 0)"): string => {
  if (typeof value === "string" && value.trim()) return value;
  const source = record(value);
  const scale = [source.r, source.g, source.b].some((channel) => finite(channel) > 1) ? 1 : 255;
  if ([source.r, source.g, source.b].every((channel) => Number.isFinite(Number(channel)))) {
    return `rgba(${Math.round(finite(source.r) * scale)}, ${Math.round(finite(source.g) * scale)}, ${Math.round(
      finite(source.b) * scale,
    )}, ${clamp(source.a ?? 1)})`;
  }
  return fallback;
};

const abortError = (): Error => {
  const error = new Error("Story scene transition was aborted");
  error.name = "AbortError";
  return error;
};

const waitForPromiseWithAbort = <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = (): void => finish(() => reject(abortError()));
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const wait = (seconds: number, signal?: AbortSignal): Promise<void> => {
  const milliseconds = Math.max(0, finite(seconds)) * 1000;
  if (signal?.aborted) return Promise.reject(abortError());
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
};

const setTransition = async (
  element: HTMLElement,
  property: string,
  value: string,
  duration = 0,
  signal?: AbortSignal,
): Promise<void> => {
  element.style.transition = duration > 0 ? `${property} ${duration}s ease` : "none";
  element.style.setProperty(property, value);
  await wait(duration, signal);
};

const createLayer = (name: string, zIndex: number): HTMLDivElement => {
  const layer = document.createElement("div");
  layer.className = `vega-stage__layer vega-stage__${name}`;
  layer.dataset.vegaLayer = name;
  layer.style.cssText = `position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:${zIndex};`;
  return layer;
};

const positionPercent = (positionType: number): number => {
  const authored = Math.round(finite(positionType, 5));
  return 8 + clamp((authored - 1) / 8) * 84;
};

const normalizedDirection = (value: unknown): number => {
  const number = finite(value);
  return clamp(Math.abs(number) <= 1 ? (number + 1) / 2 : (number / 30 + 1) / 2) * 2 - 1;
};

const stableHash = (value: unknown): number => {
  const source = String(value ?? "");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const cssNumber = (value: number): number => Math.round(value * 1_000) / 1_000;
const nowMilliseconds = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

const visualName = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  const source = record(value);
  return firstString(source.name, source.source, Object.keys(record(source.components)).join(" "));
};

const isGenericDomSeekState = (value: unknown): value is GenericDomSeekState =>
  record(value).kind === "vega-generic-dom-v1";

const GENERIC_SCENE_STYLES = `
@keyframes vega-generic-particle-rise {
  0% { transform: translate3d(0, 12vh, 0) scale(.72); opacity: 0; }
  18% { opacity: .9; }
  100% { transform: translate3d(2.5vw, -112vh, 0) scale(1.08); opacity: 0; }
}
@keyframes vega-generic-particle-fall {
  0% { transform: translate3d(-2vw, -12vh, 0) rotate(0deg); opacity: 0; }
  15% { opacity: .82; }
  100% { transform: translate3d(5vw, 112vh, 0) rotate(220deg); opacity: 0; }
}
@keyframes vega-generic-particle-drift {
  0%, 100% { transform: translate3d(-1.5vw, 1vh, 0); opacity: .28; }
  50% { transform: translate3d(2vw, -2vh, 0); opacity: .9; }
}
@keyframes vega-generic-effect-pulse {
  0%, 100% { transform: translate(-50%, -50%) scale(.72); opacity: .28; }
  50% { transform: translate(-50%, -50%) scale(1.08); opacity: .95; }
}
`;

interface SharedGenericSceneStyles {
  readonly sheet: CSSStyleSheet;
  references: number;
}

type CSSStyleSheetConstructor = new () => CSSStyleSheet;

const sharedGenericSceneStyles = new WeakMap<Document, SharedGenericSceneStyles>();

/**
 * Install effect keyframes without an inline `<style>` element. Strict hosts
 * can therefore keep `style-src 'self'` and do not need `unsafe-inline`.
 * Effects remain visible but static on older DOMs without constructable
 * stylesheet support.
 */
const acquireGenericSceneStyles = (document: Document): (() => void) => {
  const existing = sharedGenericSceneStyles.get(document);
  if (existing) {
    existing.references += 1;
    return releaseGenericSceneStyles(document, existing.sheet);
  }
  try {
    const realm = document.defaultView as
      | (Window & {
          CSSStyleSheet?: CSSStyleSheetConstructor;
        })
      | null;
    const constructor =
      realm?.CSSStyleSheet ??
      (typeof globalThis.CSSStyleSheet === "function"
        ? (globalThis.CSSStyleSheet as CSSStyleSheetConstructor)
        : undefined);
    if (!constructor) return () => undefined;
    const sheet = new constructor();
    if (typeof sheet.replaceSync !== "function") return () => undefined;
    sheet.replaceSync(GENERIC_SCENE_STYLES);
    const adopted = Array.from(document.adoptedStyleSheets);
    document.adoptedStyleSheets = adopted.includes(sheet) ? adopted : [...adopted, sheet];
    sharedGenericSceneStyles.set(document, { sheet, references: 1 });
    return releaseGenericSceneStyles(document, sheet);
  } catch {
    return () => undefined;
  }
};

const releaseGenericSceneStyles = (document: Document, sheet: CSSStyleSheet): (() => void) => {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const shared = sharedGenericSceneStyles.get(document);
    if (!shared || shared.sheet !== sheet) return;
    shared.references -= 1;
    if (shared.references > 0) return;
    try {
      document.adoptedStyleSheets = Array.from(document.adoptedStyleSheets).filter((candidate) => candidate !== sheet);
    } catch {
      // The owning realm may already be detached.
    }
    sharedGenericSceneStyles.delete(document);
  };
};

/**
 * Dependency-free default scene. It deliberately implements only portable
 * browser primitives; richer renderers replace the complete backend through a
 * render contribution.
 */
export class GenericStoryScene implements StorySceneBackend {
  readonly cameraState: StoryCameraState = {
    rotationY: 0,
    fieldRotationY: 0,
    stageRotationY: 0,
    rotationX: 0,
    angle: 0,
    zoomRatio: 1,
    baseX: 0,
    baseY: 0,
    baseZ: 0,
    panOffsetX: 0,
    panOffsetY: 0,
    focusPositionType: 5,
    focusTargetName: "",
  };

  private readonly runtime: AdvRuntimeConfig;
  private readonly resources: StoryResourceResolver;
  private readonly characterProviders: readonly StoryCharacterProvider[];
  private readonly sceneController = new AbortController();
  private state: AdvPlayerState;
  private root: HTMLDivElement | null = null;
  private backgroundLayer: HTMLDivElement | null = null;
  private characterLayer: HTMLDivElement | null = null;
  private stillLayer: HTMLDivElement | null = null;
  private stillBackdrop: HTMLDivElement | null = null;
  private stillShade: HTMLDivElement | null = null;
  private frameLayer: HTMLDivElement | null = null;
  private videoLayer: HTMLDivElement | null = null;
  private effectsLayer: HTMLDivElement | null = null;
  private lightOverlay: HTMLDivElement | null = null;
  private particleLayer: HTMLDivElement | null = null;
  private commandEffectLayer: HTMLDivElement | null = null;
  private captureLayer: HTMLDivElement | null = null;
  private postEffectLayer: HTMLDivElement | null = null;
  private stagePostOverlay: HTMLDivElement | null = null;
  private commandPostOverlay: HTMLDivElement | null = null;
  private coverLayer: HTMLDivElement | null = null;
  private backgroundImage: HTMLImageElement | null = null;
  private stillImage: HTMLImageElement | null = null;
  private frameImage: HTMLImageElement | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly preloadedImages = new Map<string, PreloadedImage>();
  private readonly imagePreloadPromises = new Map<string, Promise<HTMLImageElement>>();
  private readonly preloadedVideos = new Map<string, PreloadedVideo>();
  private readonly videoPreloadPromises = new Map<string, Promise<void>>();
  private readonly episodeVideoSources = new Set<string>();
  private readonly preloadedCharacters = new Map<string, PreloadedCharacter>();
  private readonly characterPreloadPromises = new Map<string, Promise<PreloadedCharacter>>();
  private backgroundLease: MediaLease | null = null;
  private stillLease: MediaLease | null = null;
  private frameLease: MediaLease | null = null;
  private videoLease: MediaLease | null = null;
  private background: AdvBackgroundEntry | null = null;
  private still: AdvStillEntry | null = null;
  private stillAnimationIndex = 0;
  private frame: AdvFrameEntry | null = null;
  private frameName = "";
  private stage: unknown = null;
  private deterministicReplay = false;
  private seekIndexCompilationActive = false;
  private playbackSpeed = 1;
  private captureSequence = 0;
  private commandPostEffect: unknown = null;
  private stageEnvironmentIndex = 0;
  private stageLightIndex = 0;
  private stagePostIndex = 0;
  private stageParticleIndex = 0;
  private backgroundBrightness = 1;
  private backgroundBlurIntensity = 0;
  private ruleTransitionActive = false;
  private ruleTransitionGeneration = 0;
  private commandPostGeneration = 0;
  private readonly characters = new Map<string, CharacterRecord>();
  private readonly pendingCharacters = new Map<string, PendingCharacterRecord>();
  private readonly disposedCharacterModels = new WeakSet<StoryCharacterModel>();
  private characterLoadSequence = 0;
  private readonly characterAssetIndices = new Map<string, number>();
  private readonly commandEffects = new Map<string, CommandEffectRecord>();
  private readonly stageCaptures = new Map<number, HTMLDivElement>();
  private readonly pendingLoads = new Set<Promise<unknown>>();
  private characterPriorityOrder = [4, 0, 3, 1, 2];
  private readonly cameraTweenVersions = new Map<keyof StoryCameraState, number>();
  private readonly commandShakeControllers = new Map<"background" | "character" | "still" | "talk", AbortController>();
  private backgroundShake: StoryPoint2 = { x: 0, y: 0 };
  private characterShake: StoryPoint2 = { x: 0, y: 0 };
  private cameraShake: StoryPoint2 = { x: 0, y: 0 };
  private cameraShakeMode: "idle" | "playing" | "stopping" = "idle";
  private cameraShakeController: AbortController | null = null;
  private cameraShakeFrame: number | ReturnType<typeof setTimeout> | null = null;
  private cameraShakeStartedAt = 0;
  private cameraShakeCycleStartedAt = 0;
  private cameraShakeStrength = 0;
  private cameraShakeCycleSeconds = 1;
  private cameraShakeVibrato = 2;
  private cameraShakeRandomness = 60;
  private cameraShakeFadeInSeconds = 0;
  private cameraShakeFadeOutSeconds = 0;
  private cameraShakeStopStartedAt = 0;
  private cameraShakeWeight = 0;
  private cameraShakePath = createAdvDotweenShakePath({
    duration: 1,
    strength: 0,
    vibrato: 2,
    randomness: 60,
    fadeOut: false,
    vectorBased: true,
  });
  private releaseStyles: (() => void) | null = null;
  private destroyed = false;

  constructor(
    runtime: AdvRuntimeConfig,
    state: AdvPlayerState,
    resources: StoryResourceResolver,
    options: GenericStorySceneOptions = {},
  ) {
    this.runtime = runtime;
    this.state = state;
    this.resources = resources;
    this.characterProviders = [...(options.characterProviders ?? [])];
  }

  async setup(mount: HTMLElement): Promise<void> {
    if (this.destroyed) throw new ReferenceError("Cannot set up a destroyed story scene");
    if (this.root) return;
    if (typeof document === "undefined" || typeof mount?.append !== "function") {
      throw new Error("The default Vega scene requires a browser HTMLElement mount");
    }
    const root = document.createElement("div");
    root.className = "vega-stage";
    root.dataset.vegaScene = "generic";
    root.style.cssText =
      "position:absolute;inset:0;overflow:hidden;isolation:isolate;background:var(--vega-stage-background,#050713);transform-origin:center;contain:layout paint style;";
    this.backgroundLayer = createLayer("background", 0);
    this.characterLayer = createLayer("characters", 10);
    this.stillLayer = createLayer("still", 20);
    this.videoLayer = createLayer("video", 30);
    this.effectsLayer = createLayer("effects", 35);
    this.frameLayer = createLayer("frame", 40);
    this.captureLayer = createLayer("captures", 45);
    this.postEffectLayer = createLayer("post-effects", 48);
    this.coverLayer = createLayer("cover", 50);
    this.lightOverlay = this.createEffectSurface("stage-light");
    this.particleLayer = this.createEffectSurface("stage-particles");
    this.commandEffectLayer = this.createEffectSurface("command-effects");
    this.stagePostOverlay = this.createEffectSurface("stage-post");
    this.commandPostOverlay = this.createEffectSurface("command-post");
    this.stillBackdrop = this.createEffectSurface("still-backdrop");
    this.stillBackdrop.style.background = "black";
    this.stillBackdrop.style.opacity = "0";
    this.stillBackdrop.style.zIndex = "0";
    this.stillShade = this.createEffectSurface("still-shade");
    this.stillShade.style.background = "black";
    this.stillShade.style.opacity = "0";
    this.stillShade.style.zIndex = "2";
    this.stillLayer.append(this.stillBackdrop, this.stillShade);
    this.effectsLayer.append(this.lightOverlay, this.particleLayer, this.commandEffectLayer);
    this.postEffectLayer.append(this.stagePostOverlay, this.commandPostOverlay);
    this.coverLayer.style.opacity = "0";
    root.append(
      this.backgroundLayer,
      this.characterLayer,
      this.stillLayer,
      this.videoLayer,
      this.effectsLayer,
      this.frameLayer,
      this.captureLayer,
      this.postEffectLayer,
      this.coverLayer,
    );
    mount.append(root);
    this.releaseStyles = acquireGenericSceneStyles(mount.ownerDocument);
    this.root = root;
    this.applyCameraTransform();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sceneController.abort();
    this.resetShakeState();
    this.stopCommandEffects();
    this.resetStageCapture();
    this.ruleTransitionActive = false;
    this.ruleTransitionGeneration += 1;
    this.commandPostGeneration += 1;
    await Promise.allSettled([...this.characterPreloadPromises.values()]);
    await Promise.allSettled(
      [...this.characters.values()].map((character) => this.disposeCharacterModel(character.model)),
    );
    this.characters.clear();
    this.pendingCharacters.clear();
    await Promise.allSettled(
      [...this.preloadedCharacters.values()].map((character) => this.disposeCharacterModel(character.model)),
    );
    this.preloadedCharacters.clear();
    this.characterPreloadPromises.clear();
    this.releaseLease("background");
    this.releaseLease("still");
    this.releaseLease("frame");
    this.releaseLease("video");
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute("src");
      this.video.load();
    }
    for (const prepared of this.preloadedVideos.values()) {
      prepared.element.pause();
      prepared.element.removeAttribute("src");
      prepared.element.load();
      prepared.lease.release();
    }
    this.preloadedVideos.clear();
    this.videoPreloadPromises.clear();
    this.episodeVideoSources.clear();
    for (const prepared of this.preloadedImages.values()) {
      prepared.template.removeAttribute("src");
      prepared.lease.release();
    }
    this.preloadedImages.clear();
    this.imagePreloadPromises.clear();
    this.releaseStyles?.();
    this.releaseStyles = null;
    this.root?.remove();
    this.root = null;
    this.backgroundImage = null;
    this.stillImage = null;
    this.frameImage = null;
    this.video = null;
    this.backgroundLayer = null;
    this.characterLayer = null;
    this.stillLayer = null;
    this.stillBackdrop = null;
    this.stillShade = null;
    this.videoLayer = null;
    this.effectsLayer = null;
    this.lightOverlay = null;
    this.particleLayer = null;
    this.commandEffectLayer = null;
    this.frameLayer = null;
    this.captureLayer = null;
    this.postEffectLayer = null;
    this.stagePostOverlay = null;
    this.commandPostOverlay = null;
    this.coverLayer = null;
  }

  detachState(state: AdvPlayerState): void {
    if (this.state === state) this.state = { ...state };
  }

  resize(): void {
    this.applyCameraTransform();
  }

  setDeterministicReplayActive(active: boolean): void {
    if (this.deterministicReplay === active) return;
    this.deterministicReplay = active;
    if (active) this.resetShakeState();
    this.renderStageParticles();
    for (const effect of this.commandEffects.values()) this.applyCommandEffectAnimation(effect);
  }

  async preloadTexture(url: string, signal?: AbortSignal): Promise<unknown> {
    return this.preloadDomImage(url, signal);
  }

  private async preloadDomImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    if (signal?.aborted || this.sceneController.signal.aborted) {
      throw abortError();
    }
    const resident = this.preloadedImages.get(url);
    if (resident) {
      return waitForPromiseWithAbort(Promise.resolve(resident.template), signal);
    }
    const pending = this.imagePreloadPromises.get(url);
    if (pending) return waitForPromiseWithAbort(pending, signal);
    const requestSignal = this.sceneController.signal;
    const preload = (async () => {
      const lease = await this.resources.resolveRenderable(url, requestSignal);
      const image = document.createElement("img");
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.src = lease.url;
      try {
        await this.waitForMedia(image, requestSignal);
        if (typeof image.decode === "function") await image.decode();
        if (this.destroyed || requestSignal.aborted) throw abortError();
        const existing = this.preloadedImages.get(url);
        if (existing) {
          image.removeAttribute("src");
          lease.release();
          return existing.template;
        }
        this.preloadedImages.set(url, { template: image, lease });
        return image;
      } catch (error) {
        image.removeAttribute("src");
        lease.release();
        throw error;
      }
    })().finally(() => {
      if (this.imagePreloadPromises.get(url) === preload) {
        this.imagePreloadPromises.delete(url);
      }
    });
    this.imagePreloadPromises.set(url, preload);
    this.track(preload);
    return waitForPromiseWithAbort(preload, signal);
  }

  loadTexture(url: string, signal?: AbortSignal): Promise<unknown> {
    return this.preloadTexture(url, signal);
  }

  async preloadCharacter(request: StoryCharacterPreloadRequest, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted || this.sceneController.signal.aborted) {
      throw abortError();
    }
    const cmd = request.command;
    const target = firstString(cmd.targetName, cmd.targets?.[0]?.target, cmd.characterKey);
    if (!target) return false;
    const entry = record(cmd.characterModel);
    const source = imageSource(entry);
    const provider = this.characterProviders.find((candidate) =>
      candidate.supports(entry as AdvCommand["characterModel"] & Record<string, unknown>),
    );
    if (!provider) {
      if (!source) return false;
      await this.preloadDomImage(source, signal);
      return true;
    }
    const identity = firstString(
      record(cmd).controllerIdentity,
      `${target}\u0000${Math.trunc(finite(cmd.targetAssetIndex))}`,
    );
    const resident = this.preloadedCharacters.get(identity);
    if (resident) {
      if (resident.model.isOperational === false) {
        throw new Error(`Character provider ${resident.provider.id} has a non-operational preload for ${target}`);
      }
      return true;
    }
    const active = this.characterPreloadPromises.get(identity);
    if (active) {
      const prepared = await waitForPromiseWithAbort(active, signal);
      return prepared.model.isOperational !== false;
    }

    const requestSignal = this.sceneController.signal;
    let preload!: Promise<PreloadedCharacter>;
    preload = (async () => {
      let model: StoryCharacterModel | null = null;
      try {
        model = await provider.create({
          target,
          entry,
          resources: this.resources,
          signal: requestSignal,
        });
        if (this.destroyed || requestSignal.aborted) throw abortError();
        if (!model?.element || model.isOperational === false) {
          throw new Error(`Character provider ${provider.id} failed to prepare ${target}`);
        }
        model.setPlaybackSpeed(this.playbackSpeed);
        for (const motion of new Set(request.motions.map((name) => firstString(name)).filter(Boolean))) {
          const prepared = await model.prepareMotion?.(motion);
          if (prepared === false) {
            throw new Error(`Character provider ${provider.id} could not prepare motion ${motion} for ${target}`);
          }
          if (requestSignal.aborted) throw abortError();
        }
        for (const expression of new Set(request.expressions.map((name) => firstString(name)).filter(Boolean))) {
          const prepared = await model.prepareExpression?.(expression);
          if (prepared === false) {
            throw new Error(
              `Character provider ${provider.id} could not prepare expression ${expression} for ${target}`,
            );
          }
          if (requestSignal.aborted) throw abortError();
        }
        await model.prepareFirstFrame?.();
        if (requestSignal.aborted) throw abortError();
        model.setPaused(true);
        const prepared: PreloadedCharacter = {
          identity,
          target,
          provider,
          sourceEntry: entry,
          model,
          host: this.createCharacterHost(target, provider.id, model),
        };
        const raced = this.preloadedCharacters.get(identity);
        if (raced) {
          await this.disposeCharacterModel(model);
          return raced;
        }
        this.preloadedCharacters.set(identity, prepared);
        return prepared;
      } catch (error) {
        await this.disposeCharacterModel(model);
        throw error;
      }
    })().finally(() => {
      if (this.characterPreloadPromises.get(identity) === preload) {
        this.characterPreloadPromises.delete(identity);
      }
    });
    this.characterPreloadPromises.set(identity, preload);
    this.track(preload);
    const prepared = await waitForPromiseWithAbort(preload, signal);
    return prepared.model.isOperational !== false;
  }

  stagePoint(positionType: unknown): StoryPoint3 {
    const type = finite(positionType, 5);
    const configured = record(record(this.runtime.stage).positions)[String(type)];
    const point = record(configured);
    const minimum = finite(this.runtime.stage.minX, -1.6);
    const maximum = finite(this.runtime.stage.maxX, 1.6);
    return {
      x: finite(point.x, minimum + clamp((type - 1) / 8) * (maximum - minimum)),
      y: finite(point.y),
      z: finite(point.z),
    };
  }

  focusPoint(positionType: unknown): StoryPoint3 {
    const type = finite(positionType, 5);
    const configured = record(record(record(this.runtime.stage).focusAnchors)[String(type)]);
    if (!Object.keys(configured).length) return this.stagePoint(type);
    return {
      x: finite(configured.x),
      y: finite(configured.y),
      z: finite(configured.z),
    };
  }

  characterAtPosition(positionType: unknown): StoryCharacterHandle | null {
    const target = [...this.characters.values(), ...this.pendingCharacters.values()].find(
      (character) => character.positionType === finite(positionType),
    );
    return target ?? null;
  }

  showingCharacterTargets(): string[] {
    return [...this.characters.values(), ...this.pendingCharacters.values()]
      .filter((character) => character.alpha > 0)
      .map(({ target }) => target);
  }

  characterMotionIdentity(target: string): string | null {
    return this.characters.get(target)?.identity ?? this.pendingCharacters.get(target)?.identity ?? null;
  }

  hasCharacterController(target: string): boolean {
    return this.characters.has(target) || this.pendingCharacters.has(target);
  }

  isCharacterShowing(target: string, expectedIdentity?: string): boolean {
    const character = this.characters.get(target);
    const pending = this.pendingCharacters.get(target);
    return Boolean(
      (character && character.alpha > 0 && (!expectedIdentity || character.identity === expectedIdentity)) ||
      (pending && pending.alpha > 0 && (!expectedIdentity || pending.identity === expectedIdentity)),
    );
  }

  selectCharacterAssetIndex(target: string, assetIndex: number): void {
    this.characterAssetIndices.set(target, Math.trunc(finite(assetIndex)));
  }

  setSeekIndexCompilationActive(active: boolean): void {
    this.seekIndexCompilationActive = Boolean(active);
  }

  async placeCharacter(cmd: AdvCommand, positionType: number, duration = 0): Promise<void> {
    const target = firstString(cmd.targetName, cmd.targets?.[0]?.target, cmd.characterKey);
    if (!target || !this.characterLayer) return;
    const entry = record(cmd.characterModel);
    const source = imageSource(entry);
    const provider = this.characterProviders.find((candidate) =>
      candidate.supports(entry as AdvCommand["characterModel"] & Record<string, unknown>),
    );
    if (!provider && !source) {
      throw new Error(
        `The default renderer requires a static portrait image for ${target}; install a render plugin for other character formats`,
      );
    }
    const identity = firstString(
      cmd.characterKey,
      provider ? `${provider.id}:${target}:${this.characterAssetIndices.get(target) ?? 0}` : source,
      `${target}:${this.characterAssetIndices.get(target) ?? 0}`,
    );
    let controllerIdentity = firstString(
      record(cmd).controllerIdentity,
      `${target}\u0000${Math.trunc(finite(cmd.targetAssetIndex))}`,
    );
    const previous = this.characters.get(target);
    if (previous && previous.identity !== identity) {
      this.characters.delete(target);
      await this.releaseCharacter(previous);
    }
    let character = this.characters.get(target);
    let loadedFromPending = false;
    if (!character) {
      const token = ++this.characterLoadSequence;
      const pending: PendingCharacterRecord = {
        target,
        token,
        positionType,
        identity,
        controllerIdentity,
        provider: provider ?? null,
        compilationOnly: this.seekIndexCompilationActive,
        alpha: 1,
        brightness: 1,
        paused: false,
        worldPosition: null,
        offset: { x: 0, y: 0, z: 0 },
        angle: 0,
        bodyAngle: 0,
        lookX: 0,
        lookY: 0,
        lookEnabled: false,
        lookTargetName: "",
        blurIntensity: 0,
        currentMotionName: "",
        currentMotionFadeInSeconds: 0,
        currentExpressionName: "",
        currentExpressionFadeInSeconds: 0,
        pendingPausedMotion: null,
        pendingPausedExpression: null,
        rimLight: {
          enabled: false,
          color: "transparent",
          shadowIntensity: 0,
        },
      };
      this.pendingCharacters.set(target, pending);
      let model: StoryCharacterModel;
      let host: HTMLDivElement | null = null;
      try {
        let prepared = this.seekIndexCompilationActive ? undefined : this.preloadedCharacters.get(controllerIdentity);
        if (!prepared && !this.seekIndexCompilationActive && provider) {
          const matching = [...this.preloadedCharacters.entries()].find(
            ([, candidate]) =>
              candidate.target === target && candidate.provider === provider && candidate.sourceEntry === entry,
          );
          if (matching) {
            controllerIdentity = matching[0];
            pending.controllerIdentity = controllerIdentity;
            prepared = matching[1];
          }
        }
        const activePreload = prepared
          ? undefined
          : this.seekIndexCompilationActive
            ? undefined
            : this.characterPreloadPromises.get(controllerIdentity);
        if (activePreload) {
          try {
            prepared = await waitForPromiseWithAbort(activePreload, this.sceneController.signal);
          } catch (error) {
            if (this.sceneController.signal.aborted) throw error;
          }
        }
        if (
          prepared &&
          (prepared.identity !== controllerIdentity ||
            prepared.target !== target ||
            prepared.provider !== provider ||
            prepared.sourceEntry !== entry ||
            prepared.model.isOperational === false)
        ) {
          this.preloadedCharacters.delete(controllerIdentity);
          await this.disposeCharacterModel(prepared.model);
          prepared = undefined;
        }
        if (prepared) {
          this.preloadedCharacters.delete(controllerIdentity);
          model = prepared.model;
          host = prepared.host;
        } else {
          model = provider
            ? await provider.create({
                target,
                entry,
                resources: this.resources,
                signal: this.sceneController.signal,
              })
            : await StaticPortraitModel.create({
                imageUrl: source,
                resources: this.resources,
                signal: this.sceneController.signal,
                pivot: record(record(entry.runtime).pivot),
                alt: target,
                decodedTemplate: this.preloadedImages.get(source)?.template,
              });
        }
      } catch (error) {
        if (this.pendingCharacters.get(target)?.token === token) this.pendingCharacters.delete(target);
        throw error;
      }
      const committed = this.pendingCharacters.get(target);
      if (!committed || committed.token !== token || this.destroyed) {
        await this.disposeCharacterModel(model);
        return;
      }
      if (!model?.element || model.isOperational === false) {
        await this.disposeCharacterModel(model);
        this.pendingCharacters.delete(target);
        throw new Error(`Character provider ${provider?.id ?? "static-portrait"} failed to create ${target}`);
      }
      host ??= this.createCharacterHost(target, provider?.id ?? "vega.static-portrait", model);
      this.characterLayer.append(host);
      character = {
        target,
        positionType: committed.positionType,
        identity,
        controllerIdentity: committed.controllerIdentity,
        provider: committed.provider,
        compilationOnly: committed.compilationOnly,
        model,
        host,
        sourceEntry: entry,
        alpha: committed.alpha,
        brightness: committed.brightness,
        paused: committed.paused,
        worldPosition: committed.worldPosition ? { ...committed.worldPosition } : null,
        offset: { ...committed.offset },
        angle: committed.angle,
        bodyAngle: committed.bodyAngle,
        lookX: committed.lookX,
        lookY: committed.lookY,
        lookEnabled: committed.lookEnabled,
        lookTargetName: committed.lookTargetName,
        blurIntensity: committed.blurIntensity,
        currentMotionName: committed.currentMotionName,
        currentMotionFadeInSeconds: committed.currentMotionFadeInSeconds,
        currentExpressionName: committed.currentExpressionName,
        currentExpressionFadeInSeconds: committed.currentExpressionFadeInSeconds,
        pendingPausedMotion: committed.pendingPausedMotion,
        pendingPausedExpression: committed.pendingPausedExpression,
        rimLight: { ...committed.rimLight },
      };
      this.pendingCharacters.delete(target);
      this.characters.set(target, character);
      loadedFromPending = true;
      character.model.setPaused(character.paused);
      character.model.setPlaybackSpeed(this.playbackSpeed);
      if (!character.paused) {
        if (character.currentMotionName) {
          void character.model.playMotion?.(character.currentMotionName, character.currentMotionFadeInSeconds);
        }
        if (character.currentExpressionName) {
          void character.model.playExpression?.(
            character.currentExpressionName,
            character.currentExpressionFadeInSeconds,
          );
        }
      }
      this.applyCharacterFilter(character);
    }
    // AdvCharacterHelper.ShowCharacterController resets angle/look on every
    // In, including reuse of a hidden cached controller.
    if (!loadedFromPending) {
      character.angle = 0;
      character.bodyAngle = 0;
      character.lookX = 0;
      character.lookY = 0;
      character.lookEnabled = false;
      character.lookTargetName = "";
      character.host.removeAttribute("data-look");
      character.host.removeAttribute("data-look-target");
      character.host.dataset.angle = "0";
      character.host.dataset.bodyAngle = "0";
    } else {
      if (character.lookEnabled) {
        character.host.dataset.look = `${character.lookX},${character.lookY}`;
        if (character.lookTargetName) character.host.dataset.lookTarget = character.lookTargetName;
      }
      character.host.dataset.angle = String(character.angle);
      character.host.dataset.bodyAngle = String(character.bodyAngle);
    }
    // Pending commands issued after no-wait In already own the committed
    // placement/alpha. A synchronous/reused controller receives the authored
    // In placement directly.
    if (!loadedFromPending) {
      character.positionType = positionType;
      character.worldPosition = null;
      character.alpha = 1;
    }
    this.applyCharacterTransform(character);
    this.applyCharacterPortraitTransform(character);
    this.applyCharacterPresentation(character);
    this.applyCharacterPriorities();
    await setTransition(character.host, "opacity", String(character.alpha), this.deterministicReplay ? 0 : duration);
  }

  async removeCharacter(target: string, duration = 0): Promise<boolean> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return false;
      pending.alpha = 0;
      await wait(this.deterministicReplay ? 0 : duration);
      return true;
    }
    character.alpha = 0;
    this.applyCharacterPresentation(character);
    await setTransition(character.host, "opacity", "0", this.deterministicReplay ? 0 : duration);
    return true;
  }

  async fadeCharacter(target: string, alpha: number, duration = 0): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.alpha = clamp(alpha);
      await wait(this.deterministicReplay ? 0 : duration);
      return;
    }
    character.alpha = clamp(alpha);
    this.applyCharacterPresentation(character);
    await setTransition(character.host, "opacity", String(character.alpha), this.deterministicReplay ? 0 : duration);
  }

  async moveCharacter(positionType: number, offset: Partial<StoryPoint3>, duration = 0): Promise<void> {
    const selected = [...this.characters.values(), ...this.pendingCharacters.values()].filter(
      (character) => character.positionType === positionType,
    );
    for (const character of selected) {
      character.offset = {
        x: character.offset.x + finite(offset.x),
        y: character.offset.y + finite(offset.y),
        z: character.offset.z + finite(offset.z),
      };
      if ("host" in character) {
        character.host.style.transition = this.deterministicReplay ? "none" : `transform ${duration}s ease`;
        this.applyCharacterTransform(character);
        this.applyCharacterPresentation(character);
      }
    }
    await wait(this.deterministicReplay ? 0 : duration);
  }

  async moveCharacterToWorld(
    target: string,
    destination: Partial<StoryPoint3>,
    positionType: number,
    duration = 0,
  ): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.positionType = positionType || pending.positionType;
      pending.worldPosition = {
        x: finite(destination.x),
        y: finite(destination.y),
        z: finite(destination.z),
      };
      await wait(this.deterministicReplay ? 0 : duration);
      return;
    }
    character.positionType = positionType || character.positionType;
    character.worldPosition = {
      x: finite(destination.x),
      y: finite(destination.y),
      z: finite(destination.z),
    };
    character.host.style.transition = this.deterministicReplay ? "none" : `transform ${duration}s ease`;
    this.applyCharacterTransform(character);
    this.applyCharacterPresentation(character);
    await wait(this.deterministicReplay ? 0 : duration);
  }

  prepareCharacterAngle(target: string, angle: number, bodyAngle: number, duration = 0): (() => Promise<void>) | null {
    if (!this.characters.has(target) && !this.pendingCharacters.has(target)) return null;
    return () => this.setCharacterAngle(target, angle, bodyAngle, duration);
  }

  async setCharacterAngle(target: string, angle: number, bodyAngle: number, duration = 0): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.angle = finite(angle);
      pending.bodyAngle = finite(bodyAngle);
      await wait(this.deterministicReplay ? 0 : duration);
      return;
    }
    character.angle = finite(angle);
    character.bodyAngle = finite(bodyAngle);
    character.host.dataset.angle = String(character.angle);
    character.host.dataset.bodyAngle = String(character.bodyAngle);
    const visualDuration = this.deterministicReplay ? 0 : duration;
    character.host.style.transition = visualDuration > 0 ? `transform ${visualDuration}s ease` : "none";
    if (typeof character.model.applyPresentation !== "function") {
      character.model.element.style.transition = visualDuration > 0 ? `transform ${visualDuration}s ease` : "none";
    }
    this.applyCharacterTransform(character);
    this.applyCharacterPortraitTransform(character);
    this.applyCharacterPresentation(character);
    await wait(visualDuration);
  }

  prepareLook(
    target: string,
    lookX: number,
    lookY: number,
    duration = 0,
    enabled = true,
  ): (() => Promise<void>) | null {
    if (!this.characters.has(target) && !this.pendingCharacters.has(target)) return null;
    return () => this.setLook(target, lookX, lookY, duration, enabled);
  }

  prepareLookTarget(
    target: string,
    positionType: number,
    duration = 0,
    enabled = true,
    lookTargetName = "",
  ): (() => Promise<void>) | null {
    if (!this.characters.has(target) && !this.pendingCharacters.has(target)) return null;
    return () => this.setLookTarget(target, positionType, duration, enabled, lookTargetName);
  }

  async setLook(target: string, lookX: number, lookY: number, duration = 0, enabled = true): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.lookEnabled = enabled;
      pending.lookX = enabled ? finite(lookX) : 0;
      pending.lookY = enabled ? finite(lookY) : 0;
      pending.lookTargetName = "";
      await wait(this.deterministicReplay ? 0 : duration);
      return;
    }
    character.lookEnabled = enabled;
    character.lookX = enabled ? finite(lookX) : 0;
    character.lookY = enabled ? finite(lookY) : 0;
    character.lookTargetName = "";
    if (enabled) character.host.dataset.look = `${character.lookX},${character.lookY}`;
    else character.host.removeAttribute("data-look");
    character.host.removeAttribute("data-look-target");
    const visualDuration = this.deterministicReplay ? 0 : duration;
    if (typeof character.model.applyPresentation !== "function") {
      character.model.element.style.transition = visualDuration > 0 ? `transform ${visualDuration}s ease` : "none";
    }
    this.applyCharacterPortraitTransform(character);
    this.applyCharacterPresentation(character);
    await wait(visualDuration);
  }

  async setLookTarget(
    target: string,
    positionType: number,
    duration = 0,
    enabled = true,
    lookTargetName = "",
  ): Promise<void> {
    const character = this.characters.get(target);
    const pending = this.pendingCharacters.get(target);
    if (!character && !pending) return;
    const targetCharacter = lookTargetName
      ? (this.characters.get(lookTargetName) ?? this.pendingCharacters.get(lookTargetName))
      : null;
    const source = character ?? pending!;
    const targetPosition = targetCharacter?.positionType || finite(positionType, source.positionType);
    const sourceX = this.positionPercent(source.positionType);
    const destinationX = this.positionPercent(targetPosition);
    source.lookEnabled = enabled;
    source.lookX = enabled ? clamp((destinationX - sourceX + 42) / 84) * 2 - 1 : 0;
    source.lookY = enabled
      ? normalizedDirection((targetCharacter?.worldPosition?.y ?? targetCharacter?.offset.y ?? 0) / 3)
      : 0;
    source.lookTargetName = enabled ? lookTargetName : "";
    if (!character) {
      await wait(this.deterministicReplay ? 0 : duration);
      return;
    }
    if (enabled) {
      character.host.dataset.look = `${character.lookX},${character.lookY}`;
      character.host.dataset.lookTarget = lookTargetName;
    } else {
      character.host.removeAttribute("data-look");
      character.host.removeAttribute("data-look-target");
    }
    const visualDuration = this.deterministicReplay ? 0 : duration;
    if (typeof character.model.applyPresentation !== "function") {
      character.model.element.style.transition = visualDuration > 0 ? `transform ${visualDuration}s ease` : "none";
    }
    this.applyCharacterPortraitTransform(character);
    this.applyCharacterPresentation(character);
    await wait(visualDuration);
  }

  playMotionForTarget(target: string, motionName = "", _fadeIn = -1, expectedIdentity?: string): void {
    const character = this.characters.get(target);
    const pending = this.pendingCharacters.get(target);
    if (
      (!character && !pending) ||
      (expectedIdentity && (character?.identity ?? pending?.identity) !== expectedIdentity)
    )
      return;
    const resolvedName = String(motionName || "").trim();
    const fadeIn = finite(_fadeIn, -1);
    if (!character && pending) {
      pending.currentMotionName = resolvedName;
      pending.currentMotionFadeInSeconds = fadeIn;
      if (pending.paused) pending.pendingPausedMotion = { name: resolvedName, fadeInSeconds: fadeIn };
      return;
    }
    if (!character) return;
    character.currentMotionName = resolvedName;
    character.currentMotionFadeInSeconds = fadeIn;
    character.host.dataset.motion = resolvedName;
    if (character.paused) {
      if (this.hasCharacterAnimation(character, "motion", resolvedName)) {
        character.pendingPausedMotion = { name: resolvedName, fadeInSeconds: fadeIn };
      }
      this.applyCharacterPresentation(character);
      return;
    }
    void character.model.playMotion?.(resolvedName, fadeIn);
    this.applyCharacterPresentation(character);
  }

  playExpressionForTarget(target: string, expressionName = "", _fadeIn = -1, expectedIdentity?: string): void {
    const character = this.characters.get(target);
    const pending = this.pendingCharacters.get(target);
    if (
      (!character && !pending) ||
      (expectedIdentity && (character?.identity ?? pending?.identity) !== expectedIdentity)
    )
      return;
    const resolvedName = String(expressionName || "").trim();
    const fadeIn = finite(_fadeIn, -1);
    if (!character && pending) {
      if (pending.currentExpressionName === resolvedName) return;
      pending.currentExpressionName = resolvedName;
      pending.currentExpressionFadeInSeconds = fadeIn;
      if (pending.paused) {
        pending.pendingPausedExpression = { name: resolvedName, fadeInSeconds: fadeIn };
      }
      return;
    }
    if (!character) return;
    // Live2DCharacterController returns early when the requested expression is
    // already current. Preserve that format-neutral controller behavior.
    if (character.currentExpressionName === resolvedName) return;
    character.currentExpressionName = resolvedName;
    character.currentExpressionFadeInSeconds = fadeIn;
    character.host.dataset.expression = resolvedName;
    if (character.paused) {
      if (this.hasCharacterAnimation(character, "expression", resolvedName)) {
        character.pendingPausedExpression = { name: resolvedName, fadeInSeconds: fadeIn };
      }
      this.applyCharacterPresentation(character);
      return;
    }
    void character.model.playExpression?.(resolvedName, fadeIn);
    this.applyCharacterPresentation(character);
  }

  setCharacterPaused(target: string, paused: boolean): void {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.paused = Boolean(paused);
      if (!pending.paused) {
        if (pending.pendingPausedMotion) {
          pending.currentMotionName = pending.pendingPausedMotion.name;
          pending.currentMotionFadeInSeconds = pending.pendingPausedMotion.fadeInSeconds;
        }
        if (pending.pendingPausedExpression) {
          pending.currentExpressionName = pending.pendingPausedExpression.name;
          pending.currentExpressionFadeInSeconds = pending.pendingPausedExpression.fadeInSeconds;
        }
        pending.pendingPausedMotion = null;
        pending.pendingPausedExpression = null;
      }
      return;
    }
    character.paused = Boolean(paused);
    character.model.setPaused(character.paused);
    if (!character.paused) {
      // Native Resume resets expression-owned parameters before applying the
      // last paused Motion/Expression slots, even on a repeated Resume.
      void character.model.resetExpressionParameters?.();
      const motion = character.pendingPausedMotion;
      const expression = character.pendingPausedExpression;
      character.pendingPausedMotion = null;
      character.pendingPausedExpression = null;
      if (motion) void character.model.playMotion?.(motion.name, motion.fadeInSeconds);
      if (expression) void character.model.playExpression?.(expression.name, expression.fadeInSeconds);
    }
    this.applyCharacterPresentation(character);
  }

  setCharacterForward(positionType: number): void {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return;
    this.characterPriorityOrder = this.characterPriorityOrder.filter((value) => value !== index);
    this.characterPriorityOrder.push(index);
    this.applyCharacterPriorities();
  }

  setCharacterBack(positionType: number): void {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return;
    this.characterPriorityOrder = [index, ...this.characterPriorityOrder.filter((value) => value !== index)];
    this.applyCharacterPriorities();
  }

  sortCharacters(): void {
    this.characterPriorityOrder = [4, 0, 3, 1, 2];
    this.applyCharacterPriorities();
  }

  setPlaybackSpeed(rate: number): void {
    this.playbackSpeed = Math.max(0.01, finite(rate, 1));
    for (const character of this.characters.values()) {
      character.model.setPlaybackSpeed(this.playbackSpeed);
      this.applyCharacterPresentation(character);
    }
    if (this.video) this.video.playbackRate = this.playbackSpeed;
    this.renderStageParticles();
    for (const effect of this.commandEffects.values()) this.applyCommandEffectAnimation(effect);
  }

  async setBackground(
    background: AdvBackgroundEntry | null | undefined,
    duration = 0,
    _captureToken?: number | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.backgroundLayer) return false;
    const source = backgroundSource(background);
    if (!source) {
      this.background = null;
      this.backgroundImage?.remove();
      this.backgroundImage = null;
      this.releaseLease("background");
      return true;
    }
    const image = await this.createPreloadedImage(source, signal);
    image.className = "vega-stage__background-image";
    image.alt = "";
    image.draggable = false;
    image.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;filter:brightness(1);will-change:opacity,filter,transform;";
    await this.waitForMedia(image, signal);
    this.backgroundLayer.append(image);
    const previous = this.backgroundImage;
    this.backgroundImage = image;
    this.releaseLease("background");
    this.background = background ?? null;
    this.stage = background?.stage ?? this.stage;
    this.applyBackgroundFilter();
    await setTransition(image, "opacity", "1", this.deterministicReplay ? 0 : duration, signal);
    previous?.remove();
    return true;
  }

  async captureStage(signal?: AbortSignal): Promise<number | null> {
    if (signal?.aborted || !this.captureLayer) return null;
    const owner = ++this.captureSequence;
    const capture = document.createElement("div");
    capture.className = "vega-stage__capture";
    capture.dataset.vegaCapture = String(owner);
    capture.style.cssText =
      "position:absolute;inset:0;overflow:hidden;opacity:1;pointer-events:none;will-change:opacity;";
    for (const layer of [
      this.backgroundLayer,
      this.characterLayer,
      this.stillLayer,
      this.videoLayer,
      this.effectsLayer,
      this.frameLayer,
    ]) {
      if (layer) capture.append(layer.cloneNode(true));
    }
    this.captureLayer.append(capture);
    this.stageCaptures.set(owner, capture);
    return owner;
  }

  async fadeStageCapture(duration: number, owner: number, signal?: AbortSignal): Promise<boolean> {
    const capture = this.stageCaptures.get(owner);
    if (!capture) return false;
    try {
      await setTransition(capture, "opacity", "0", this.deterministicReplay ? 0 : duration, signal);
      return true;
    } finally {
      capture.remove();
      this.stageCaptures.delete(owner);
    }
  }

  resetStageCapture(owner?: number): void {
    if (owner != null) {
      this.stageCaptures.get(owner)?.remove();
      this.stageCaptures.delete(owner);
      return;
    }
    for (const capture of this.stageCaptures.values()) capture.remove();
    this.stageCaptures.clear();
  }

  async setStill(still: AdvStillEntry | null | undefined, alpha = 1, duration = 0): Promise<void> {
    if (!this.stillLayer) return;
    const source = backgroundSource(still);
    if (!source) {
      await this.clearStill(duration);
      return;
    }
    const image = await this.createPreloadedImage(source, this.sceneController.signal);
    image.className = "vega-stage__still-image";
    image.alt = "";
    image.draggable = false;
    image.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;z-index:1;will-change:opacity,transform;";
    await this.waitForMedia(image);
    this.stillLayer.append(image);
    if (this.stillShade) this.stillLayer.append(this.stillShade);
    this.stillImage?.remove();
    this.stillImage = image;
    this.releaseLease("still");
    this.still = still ?? null;
    await setTransition(image, "opacity", String(clamp(alpha)), this.deterministicReplay ? 0 : duration);
  }

  runStillCommand(
    still: AdvStillEntry | null | undefined,
    alpha = 1,
    overlayAlpha = 1,
    animationIndex = 0,
    duration = 0,
  ): Promise<void> {
    if (this.stillImage) return this.clearStill(duration);
    this.stillAnimationIndex = Math.max(0, Math.trunc(finite(animationIndex)));
    return Promise.all([this.setStill(still, alpha, duration), this.setStillViewAlpha(1, overlayAlpha, duration)]).then(
      () => {
        if (!this.stillImage) return;
        this.stillImage.dataset.animationIndex = String(this.stillAnimationIndex);
        this.applyStillAnimation(this.stillImage, this.stillAnimationIndex, duration);
      },
    );
  }

  async fadeStill(alpha: number, duration = 0): Promise<void> {
    if (this.stillImage)
      await setTransition(this.stillImage, "opacity", String(clamp(alpha)), this.deterministicReplay ? 0 : duration);
  }

  async clearStill(duration = 0): Promise<void> {
    const image = this.stillImage;
    await Promise.all([
      image ? setTransition(image, "opacity", "0", this.deterministicReplay ? 0 : duration) : Promise.resolve(),
      this.setStillViewAlpha(0, 0, duration),
    ]);
    image?.remove();
    this.stillImage = null;
    this.still = null;
    this.stillAnimationIndex = 0;
    this.releaseLease("still");
  }

  async setFrameOverlay(frame: AdvFrameEntry, alpha = 1, key = ""): Promise<void> {
    if (!this.frameLayer) return;
    this.frame = frame;
    this.frameName = key;
    this.frameLayer.dataset.frame = key;
    const source = backgroundSource(frame);
    if (!source) {
      this.frameImage?.remove();
      this.frameImage = null;
      this.releaseLease("frame");
      this.setFrameOpacity(alpha, 0, key);
      return;
    }
    const image = await this.createPreloadedImage(source, this.sceneController.signal);
    image.className = "vega-stage__frame-image";
    image.alt = "";
    image.draggable = false;
    image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
    await this.waitForMedia(image);
    this.frameLayer.append(image);
    this.frameImage?.remove();
    this.frameImage = image;
    this.releaseLease("frame");
    this.setFrameOpacity(alpha, 0, key);
  }

  setFrameOpacity(alpha: number, slide = 0, key = ""): void {
    if (!this.frameLayer || (key && this.frameName && key !== this.frameName)) return;
    this.frameLayer.style.opacity = String(clamp(alpha));
    this.frameLayer.style.transform = `translateY(${finite(slide) * 100}%)`;
  }

  clearFrameOverlay(key?: string): void {
    if (!this.frameLayer || (key && this.frameName && key !== this.frameName)) return;
    this.frameImage?.remove();
    this.frameImage = null;
    this.releaseLease("frame");
    this.frameLayer.style.opacity = "0";
    this.frameLayer.removeAttribute("data-frame");
    this.frame = null;
    this.frameName = "";
  }

  setCover(color: unknown, opacity: unknown): void {
    if (!this.coverLayer) return;
    this.ruleTransitionGeneration += 1;
    this.ruleTransitionActive = false;
    this.clearRuleVisual();
    this.coverLayer.style.background = colorCss(color);
    this.coverLayer.style.opacity = String(clamp(opacity));
  }

  async flashWhite(duration = 0.12): Promise<void> {
    if (!this.coverLayer) return;
    const half = Math.max(0, duration) / 2;
    this.coverLayer.style.background = "white";
    await setTransition(this.coverLayer, "opacity", "1", half);
    await setTransition(this.coverLayer, "opacity", "0", half);
  }

  async runRuleTransition(
    rule: AdvRuleTransitionEntry | null | undefined,
    color: unknown,
    duration: number,
    reveal: boolean,
  ): Promise<void> {
    if (!this.coverLayer) return;
    const cover = this.coverLayer;
    const visualDuration = this.deterministicReplay ? 0 : Math.max(0, finite(duration));
    const name = firstString(rule?.name, rule?.source, rule?.texture, rule?.maskTexture, "rule");
    const angle = stableHash(name) % 180;
    const tone = colorCss(color);
    const generation = ++this.ruleTransitionGeneration;
    this.ruleTransitionActive = true;
    cover.dataset.ruleTransition = name;
    cover.style.backgroundColor = tone;
    cover.style.backgroundImage = rule?.gradient
      ? `linear-gradient(${angle}deg, color-mix(in srgb, ${tone} 78%, white), ${tone} 48%, color-mix(in srgb, ${tone} 82%, black))`
      : `repeating-linear-gradient(${angle}deg, transparent 0 12px, rgb(255 255 255 / .08) 12px 13px), linear-gradient(${tone}, ${tone})`;
    cover.style.opacity = "1";
    cover.style.clipPath = reveal ? "inset(0 100% 0 0)" : "inset(0)";
    cover.style.transition = visualDuration > 0 ? `clip-path ${visualDuration}s cubic-bezier(.32,.72,0,1)` : "none";
    void cover.offsetWidth;
    cover.style.clipPath = reveal ? "inset(0)" : "inset(0 0 0 100%)";
    try {
      await wait(visualDuration);
    } finally {
      if (generation === this.ruleTransitionGeneration) this.ruleTransitionActive = false;
    }
    if (generation !== this.ruleTransitionGeneration) return;
    if (!reveal) {
      cover.style.opacity = "0";
      this.clearRuleVisual();
    }
  }

  setVideoLayout(layout?: import("../../types/AdvRuntime").StoryVideoLayout): void {
    this.state.video.layout = layout;
    if (!this.video) return;
    const viewport = layout?.viewport ?? [0, 0, 1, 1];
    Object.assign(this.video.style, {
      inset: "auto",
      left: `${finite(viewport[0]) * 100}%`,
      top: `${finite(viewport[1]) * 100}%`,
      width: `${Math.max(0, finite(viewport[2], 1)) * 100}%`,
      height: `${Math.max(0, finite(viewport[3], 1)) * 100}%`,
      objectFit: layout?.fit === "stretch" ? "fill" : (layout?.fit ?? "cover"),
      backgroundColor: layout?.background ?? "transparent",
    });
  }

  async showVideo(
    video: AdvVideoEntry | string,
    fadeIn = 0,
    startRatio = 0,
    playbackRate = 1,
    signal?: AbortSignal,
    alpha = 1,
  ): Promise<void> {
    if (!this.videoLayer) return;
    const source = backgroundSource(video);
    if (!source) return;
    await this.hideVideo(0);
    const prepared = this.preloadedVideos.get(source);
    this.preloadedVideos.delete(source);
    const lease = prepared?.lease || (await this.resources.resolveRenderable(source, signal));
    const element = prepared?.element || document.createElement("video");
    element.className = "vega-stage__video-element";
    element.playsInline = true;
    element.preload = "auto";
    element.muted = false;
    element.volume = 1;
    element.dataset.vegaSource = source;
    element.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;pointer-events:none;";
    if (!prepared) element.src = lease.url;
    element.playbackRate = Math.max(0.01, finite(playbackRate, 1));
    this.videoLayer.append(element);
    this.video = element;
    this.setVideoLayout(this.state.video.layout);
    this.videoLease = lease;
    await this.waitForVideoReady(element, HTMLMediaElement.HAVE_FUTURE_DATA, "canplay", signal);
    if (startRatio > 0 && Number.isFinite(element.duration)) element.currentTime = element.duration * clamp(startRatio);
    await element.play();
    await setTransition(element, "opacity", String(clamp(alpha)), this.deterministicReplay ? 0 : fadeIn, signal);
  }

  async fadeVideo(alpha: number, duration = 0): Promise<void> {
    if (this.video)
      await setTransition(this.video, "opacity", String(clamp(alpha)), this.deterministicReplay ? 0 : duration);
  }

  async hideVideo(fadeOut = 0): Promise<void> {
    const video = this.video;
    if (!video) return;
    await setTransition(video, "opacity", "0", this.deterministicReplay ? 0 : fadeOut);
    video.pause();
    video.remove();
    const source = video.dataset.vegaSource || "";
    const lease = this.videoLease;
    this.video = null;
    this.videoLease = null;
    if (source && lease && this.episodeVideoSources.has(source)) {
      try {
        video.currentTime = 0;
      } catch {}
      video.muted = true;
      video.volume = 0;
      this.preloadedVideos.set(source, { element: video, lease });
    } else {
      video.removeAttribute("src");
      video.load();
      lease?.release();
    }
  }

  async preloadVideo(source: string, signal?: AbortSignal): Promise<void> {
    if (!source) return;
    if (signal?.aborted || this.destroyed || this.sceneController.signal.aborted) {
      throw abortError();
    }
    this.episodeVideoSources.add(source);
    const resident = this.preloadedVideos.get(source);
    if (resident && resident.element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return waitForPromiseWithAbort(Promise.resolve(), signal);
    }
    const pending = this.videoPreloadPromises.get(source);
    if (pending) return waitForPromiseWithAbort(pending, signal);
    if (resident) {
      resident.element.removeAttribute("src");
      resident.element.load();
      resident.lease.release();
      this.preloadedVideos.delete(source);
    }
    const requestSignal = this.sceneController.signal;
    const preload = (async () => {
      const lease = await this.resources.resolveRenderable(source, requestSignal);
      const element = document.createElement("video");
      element.src = lease.url;
      element.dataset.vegaSource = source;
      element.playsInline = true;
      element.preload = "auto";
      element.autoplay = false;
      element.controls = false;
      element.muted = true;
      element.volume = 0;
      this.preloadedVideos.set(source, { element, lease });
      try {
        element.load();
        await this.waitForVideoReady(element, HTMLMediaElement.HAVE_CURRENT_DATA, "loadeddata", requestSignal);
        await this.waitForVideoReady(element, HTMLMediaElement.HAVE_FUTURE_DATA, "canplay", requestSignal);
      } catch (error) {
        if (this.preloadedVideos.get(source)?.element === element) {
          this.preloadedVideos.delete(source);
        }
        element.removeAttribute("src");
        element.load();
        lease.release();
        throw error;
      }
    })().finally(() => {
      if (this.videoPreloadPromises.get(source) === preload) {
        this.videoPreloadPromises.delete(source);
      }
    });
    this.videoPreloadPromises.set(source, preload);
    this.track(preload);
    await waitForPromiseWithAbort(preload, signal);
  }

  skipVideo(): boolean {
    if (!this.video) return false;
    if (Number.isFinite(this.video.duration)) this.video.currentTime = this.video.duration;
    return true;
  }

  seekVideoRatio(ratio: unknown): boolean {
    if (!this.video || !Number.isFinite(this.video.duration)) return false;
    this.video.currentTime = this.video.duration * clamp(ratio);
    return true;
  }

  waitVideoEnded(signal?: AbortSignal): Promise<void> {
    const video = this.video;
    if (!video || video.ended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        video.removeEventListener("ended", finish);
        signal?.removeEventListener("abort", abort);
      };
      video.addEventListener("ended", finish, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async setCommandPostEffect(profile: AdvPostEffectEntry | string | unknown, fade = 0): Promise<void> {
    if (!this.root || !this.commandPostOverlay) return;
    const name = visualName(profile);
    if (!name) {
      await this.clearCommandPostEffects(fade);
      return;
    }
    const generation = ++this.commandPostGeneration;
    this.commandPostEffect = profile;
    this.root.dataset.postEffect = name;
    const visual = this.commandPostVisual(profile);
    const visualDuration = this.deterministicReplay ? 0 : Math.max(0, finite(fade));
    this.root.style.transition = visualDuration > 0 ? `filter ${visualDuration}s ease` : "none";
    this.commandPostOverlay.style.transition = visualDuration > 0 ? `opacity ${visualDuration}s ease` : "none";
    this.root.style.filter = visual.filter;
    this.commandPostOverlay.style.background = visual.overlay;
    this.commandPostOverlay.style.mixBlendMode = visual.blendMode;
    this.commandPostOverlay.style.opacity = String(visual.opacity);
    await wait(visualDuration);
    if (generation !== this.commandPostGeneration) return;
  }

  async clearCommandPostEffects(fade = 0): Promise<void> {
    if (!this.root || !this.commandPostOverlay) return;
    const root = this.root;
    const overlay = this.commandPostOverlay;
    const generation = ++this.commandPostGeneration;
    const visualDuration = this.deterministicReplay ? 0 : Math.max(0, finite(fade));
    root.style.transition = visualDuration > 0 ? `filter ${visualDuration}s ease` : "none";
    overlay.style.transition = visualDuration > 0 ? `opacity ${visualDuration}s ease` : "none";
    root.style.filter = "none";
    overlay.style.opacity = "0";
    await wait(visualDuration);
    if (generation !== this.commandPostGeneration || this.destroyed) return;
    this.commandPostEffect = null;
    root.removeAttribute("data-post-effect");
    overlay.style.background = "";
    overlay.style.mixBlendMode = "";
  }

  async playCommandEffect(
    asset: AdvEffectEntry | null,
    options: {
      readonly key?: string;
      readonly targetName?: string;
      readonly positionType?: number;
      readonly [key: string]: unknown;
    } = {},
  ): Promise<void> {
    const values = options as Readonly<Record<string, unknown>>;
    const key = firstString(options.key, values.targetName, record(asset).key, record(asset).name, "effect");
    const current = this.commandEffects.get(key);
    if (current) {
      current.element.remove();
      this.commandEffects.delete(key);
      return;
    }
    this.mountCommandEffect(key, asset, values);
  }

  isCommandEffectPlaying(key: string): boolean {
    return this.commandEffects.has(key);
  }

  stopCommandEffects(): void {
    for (const effect of this.commandEffects.values()) effect.element.remove();
    this.commandEffects.clear();
    if (this.commandEffectLayer) this.commandEffectLayer.style.opacity = "0";
  }

  applyStageEnv(index = 0): void {
    this.stageEnvironmentIndex = Math.trunc(finite(index));
    this.stage = { type: "environment", index: this.stageEnvironmentIndex };
    if (!this.root) return;
    this.root.dataset.stageEnvironment = String(this.stageEnvironmentIndex);
    const hue = stableHash(this.stageEnvironmentIndex) % 360;
    this.root.style.setProperty(
      "--vega-stage-background",
      this.stageEnvironmentIndex
        ? `radial-gradient(circle at 50% 18%, hsl(${hue} 38% 18%), hsl(${(hue + 34) % 360} 32% 6%) 72%)`
        : "#050713",
    );
  }

  applyStageLight(index = 0): void {
    this.stageLightIndex = Math.trunc(finite(index));
    if (!this.root || !this.lightOverlay) return;
    this.root.dataset.stageLight = String(this.stageLightIndex);
    if (!this.stageLightIndex) {
      this.lightOverlay.style.opacity = "0";
      this.lightOverlay.style.background = "";
      return;
    }
    const hue = stableHash(`light:${this.stageLightIndex}`) % 360;
    this.lightOverlay.style.background = `radial-gradient(circle at 50% 14%, hsl(${hue} 92% 78% / .58), transparent 52%), linear-gradient(115deg, hsl(${(hue + 28) % 360} 80% 72% / .18), transparent 48%)`;
    this.lightOverlay.style.mixBlendMode = "screen";
    this.lightOverlay.style.opacity = String(0.25 + (Math.abs(this.stageLightIndex) % 4) * 0.08);
  }

  applyStagePostEffect(index = 0): void {
    this.stagePostIndex = Math.trunc(finite(index));
    if (!this.root || !this.stagePostOverlay) return;
    this.root.dataset.stagePost = String(this.stagePostIndex);
    if (!this.stagePostIndex) {
      this.stagePostOverlay.style.opacity = "0";
      this.stagePostOverlay.style.background = "";
      this.stagePostOverlay.style.backdropFilter = "";
      return;
    }
    const hue = stableHash(`post:${this.stagePostIndex}`) % 360;
    this.stagePostOverlay.style.background = `linear-gradient(135deg, hsl(${hue} 70% 55% / .08), hsl(${(hue + 120) % 360} 76% 38% / .12))`;
    this.stagePostOverlay.style.backdropFilter = `saturate(${1.04 + (Math.abs(this.stagePostIndex) % 4) * 0.08}) contrast(1.04)`;
    this.stagePostOverlay.style.mixBlendMode = "soft-light";
    this.stagePostOverlay.style.opacity = "1";
  }

  changeStageParticleEffects(index = 0): void {
    this.stageParticleIndex = Math.trunc(finite(index));
    if (this.root) this.root.dataset.stageParticles = String(this.stageParticleIndex);
    this.renderStageParticles();
  }

  setRendererCharacterBrightness(target: string, value: number, duration = 0, _positionType?: number): Promise<void> {
    return this.setBrightness(target, value, duration);
  }

  async setBrightness(target: string, value: number, duration = 0): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.brightness = clamp(value);
      await wait(this.deterministicReplay ? 0 : duration);
      return;
    }
    character.brightness = clamp(value);
    character.host.style.transition = this.deterministicReplay ? "none" : `filter ${duration}s ease`;
    this.applyCharacterFilter(character);
    this.applyCharacterPresentation(character);
    await wait(this.deterministicReplay ? 0 : duration);
  }

  async setPositionBrightness(positionType: number, value: number, duration = 0): Promise<void> {
    const character = this.characterAtPosition(positionType);
    if (character) await this.setBrightness(character.target, value, duration);
  }

  async setBackgroundBrightness(value: number, duration = 0): Promise<void> {
    if (!this.backgroundImage) return;
    this.backgroundBrightness = clamp(value);
    this.backgroundImage.style.transition = this.deterministicReplay ? "none" : `filter ${duration}s ease`;
    this.applyBackgroundFilter();
    await wait(this.deterministicReplay ? 0 : duration);
  }

  async setBackgroundDoF(intensity: number, duration = 0, _ease?: unknown, signal?: AbortSignal): Promise<void> {
    if (!this.backgroundImage) return;
    this.backgroundBlurIntensity = clamp(intensity);
    this.backgroundImage.style.transition = this.deterministicReplay ? "none" : `filter ${duration}s ease`;
    this.applyBackgroundFilter();
    await wait(this.deterministicReplay ? 0 : duration, signal);
  }

  async setCharacterDoF(
    target: string,
    intensity: number,
    duration = 0,
    _ease?: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.blurIntensity = clamp(intensity);
      await wait(this.deterministicReplay ? 0 : duration, signal);
      return;
    }
    character.blurIntensity = clamp(intensity);
    character.host.style.transition = this.deterministicReplay ? "none" : `filter ${duration}s ease`;
    this.applyCharacterFilter(character);
    this.applyCharacterPresentation(character);
    await wait(this.deterministicReplay ? 0 : duration, signal);
  }

  cancelPendingCharacterDoF(_target: string): void {}

  async setRimLight(target: string, color: unknown, shadowIntensity: number): Promise<void> {
    const character = this.characters.get(target);
    if (!character) {
      const pending = this.pendingCharacters.get(target);
      if (!pending) return;
      pending.rimLight = {
        enabled: true,
        color,
        shadowIntensity: Math.max(0, finite(shadowIntensity)),
      };
      return;
    }
    character.rimLight = {
      enabled: true,
      color,
      shadowIntensity: Math.max(0, finite(shadowIntensity)),
    };
    this.applyCharacterFilter(character);
    this.applyCharacterPresentation(character);
  }

  currentFocusData(distance: number): AdvFocusDataRow | null {
    const rows = this.runtime.focusData ?? [];
    return rows[Math.max(0, Math.min(rows.length - 1, Math.round(finite(distance))))] ?? null;
  }

  closestFocusDataByZoomRatio(ratio: number): AdvFocusDataRow | null {
    const rows = this.runtime.focusData ?? [];
    return (
      rows.reduce<AdvFocusDataRow | null>((closest, row) => {
        if (!closest) return row;
        return Math.abs(row.fieldZoomRatio - ratio) < Math.abs(closest.fieldZoomRatio - ratio) ? row : closest;
      }, null) ?? null
    );
  }

  focusBaseCameraPosition(
    positionType: number,
    targetName = "",
    focusData: AdvFocusDataRow | null = null,
  ): StoryPoint3 {
    const point = this.focusPoint(positionType);
    const target = targetName ? this.characters.get(targetName) : null;
    const targetHeadY = target ? (target.worldPosition?.y ?? target.offset.y) + 1.6 : null;
    return {
      x: point.x,
      y:
        targetHeadY == null
          ? point.y + finite(focusData?.fieldZoomOffsetY)
          : targetHeadY - finite(focusData?.characterHeadFocusOffsetY),
      z: 0,
    };
  }

  async focus(options: Readonly<Record<string, unknown>>): Promise<void> {
    const positionType = finite(options.positionType, 5);
    const targetName = firstString(options.targetName);
    const focusData = this.currentFocusData(finite(options.cameraDistance));
    const target = this.focusBaseCameraPosition(positionType, targetName, focusData);
    const from = { ...this.cameraState };
    const fromBackgroundBlur = this.backgroundBlurIntensity;
    const targetBackgroundBlur = clamp(focusData?.backgroundBlurIntensity);
    const characterBlur = new Map(
      [...this.characters.values()].map((character) => [
        character.target,
        {
          from: character.blurIntensity,
          to: character.positionType === positionType ? 0 : clamp(focusData?.characterBlurIntensity),
        },
      ]),
    );
    const keys: (keyof StoryCameraState)[] = [
      "baseX",
      "baseY",
      "baseZ",
      "rotationY",
      "stageRotationY",
      "zoomRatio",
      "panOffsetX",
      "panOffsetY",
    ];
    const ownership = this.beginCameraTween(keys);
    await this.runSceneTween({
      duration: finite(options.duration),
      ease: options.ease,
      signal: options.signal as AbortSignal | undefined,
      update: (progress) => {
        this.cameraState.focusPositionType = positionType;
        this.cameraState.focusTargetName = targetName;
        this.writeCameraTween(ownership, "baseX", lerp(from.baseX, target.x, progress));
        this.writeCameraTween(ownership, "baseY", lerp(from.baseY, target.y, progress));
        this.writeCameraTween(ownership, "baseZ", lerp(from.baseZ, target.z, progress));
        this.writeCameraTween(ownership, "rotationY", lerp(from.rotationY, 0, progress));
        this.writeCameraTween(ownership, "stageRotationY", lerp(from.stageRotationY, 0, progress));
        this.writeCameraTween(
          ownership,
          "zoomRatio",
          lerp(from.zoomRatio, Math.max(0.001, finite(focusData?.fieldZoomRatio, 1)), progress),
        );
        this.writeCameraTween(ownership, "panOffsetX", lerp(from.panOffsetX, 0, progress));
        this.writeCameraTween(ownership, "panOffsetY", lerp(from.panOffsetY, 0, progress));
        this.backgroundBlurIntensity = lerp(fromBackgroundBlur, targetBackgroundBlur, progress);
        this.applyBackgroundFilter();
        for (const character of this.characters.values()) {
          const blur = characterBlur.get(character.target);
          if (!blur) continue;
          character.blurIntensity = lerp(blur.from, blur.to, progress);
          this.applyCharacterFilter(character);
          this.applyCharacterPresentation(character);
        }
        this.applyCameraTransform();
      },
    });
  }

  async zoomByRatio(
    ratio: number,
    duration = 0,
    ease?: unknown,
    backgroundBlurOffset?: number | null,
    adjustBackgroundBlur = true,
    signal?: AbortSignal,
  ): Promise<void> {
    const from = this.cameraState.zoomRatio;
    const target = Math.max(0.001, finite(ratio, 1));
    const focusData = this.closestFocusDataByZoomRatio(target);
    const fromBlur = this.backgroundBlurIntensity;
    const targetBlur =
      clamp(focusData?.backgroundBlurIntensity) + (backgroundBlurOffset == null ? 0 : finite(backgroundBlurOffset));
    const ownership = this.beginCameraTween(["zoomRatio"]);
    await this.runSceneTween({
      duration,
      ease,
      signal,
      update: (progress) => {
        this.writeCameraTween(ownership, "zoomRatio", lerp(from, target, progress));
        if (adjustBackgroundBlur) {
          this.backgroundBlurIntensity = clamp(lerp(fromBlur, targetBlur, progress));
          this.applyBackgroundFilter();
        }
        this.applyCameraTransform();
      },
    });
  }

  async setCharacterStagesY(y: number, duration = 0, ease?: unknown, signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.fieldRotationY;
    const target = finite(y);
    const ownership = this.beginCameraTween(["fieldRotationY"]);
    await this.runSceneTween({
      duration,
      ease,
      signal,
      update: (progress) => {
        this.writeCameraTween(ownership, "fieldRotationY", lerp(from, target, progress));
        this.applyCameraTransform();
      },
    });
  }

  async setTilt(angle: number, duration = 0, ease?: unknown, signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.rotationX;
    const target = finite(angle);
    const ownership = this.beginCameraTween(["rotationX"]);
    await this.runSceneTween({
      duration,
      ease,
      signal,
      update: (progress) => {
        this.writeCameraTween(ownership, "rotationX", lerp(from, target, progress));
        this.applyCameraTransform();
      },
    });
  }

  async setCameraRoll(angle: number, duration = 0, ease?: unknown, signal?: AbortSignal): Promise<void> {
    const from = this.cameraState.angle;
    const target = finite(angle);
    const ownership = this.beginCameraTween(["angle"]);
    await this.runSceneTween({
      duration,
      ease,
      signal,
      update: (progress) => {
        this.writeCameraTween(ownership, "angle", lerp(from, target, progress));
        this.applyCameraTransform();
      },
    });
  }

  panFocusDistance(focusPosition: { z?: number }): number {
    const stage = record(this.state.stage || this.runtime.stage);
    const characterField = record(stage.characterFieldPosition ?? this.runtime.stage.characterFieldPosition);
    return Math.abs(finite(characterField.z, 5.5) - finite(focusPosition.z));
  }

  panV2CameraOffset(rotationY: number, distance: number, focusSlideRate: number): StoryPoint2 {
    const radians = (finite(rotationY) * Math.PI) / 180;
    const radiusRate = 1 - finite(focusSlideRate, 0.5);
    return {
      x: -radiusRate * finite(distance) * Math.sin(radians),
      y: radiusRate * finite(distance) * (1 - Math.cos(radians)),
    };
  }

  async setPanV2CameraOffset(
    offset: Partial<StoryPoint2>,
    duration = 0,
    ease?: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const from = { x: this.cameraState.panOffsetX, y: this.cameraState.panOffsetY };
    const target = { x: finite(offset.x), y: finite(offset.y) };
    const ownership = this.beginCameraTween(["panOffsetX", "panOffsetY"]);
    await this.runSceneTween({
      duration,
      ease,
      signal,
      update: (progress) => {
        this.writeCameraTween(ownership, "panOffsetX", lerp(from.x, target.x, progress));
        this.writeCameraTween(ownership, "panOffsetY", lerp(from.y, target.y, progress));
        this.applyCameraTransform();
      },
    });
  }

  async setPanV2BaseCameraPosition(
    position: Partial<StoryPoint3>,
    duration = 0,
    ease?: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const from = { x: this.cameraState.baseX, y: this.cameraState.baseY, z: this.cameraState.baseZ };
    const target = { x: finite(position.x), y: finite(position.y), z: finite(position.z) };
    const ownership = this.beginCameraTween(["baseX", "baseY", "baseZ"]);
    await this.runSceneTween({
      duration,
      ease,
      signal,
      update: (progress) => {
        this.writeCameraTween(ownership, "baseX", lerp(from.x, target.x, progress));
        this.writeCameraTween(ownership, "baseY", lerp(from.y, target.y, progress));
        this.writeCameraTween(ownership, "baseZ", lerp(from.z, target.z, progress));
        this.applyCameraTransform();
      },
    });
  }

  async panV2(options: Readonly<Record<string, unknown>>): Promise<void> {
    const from = {
      rotationY: this.cameraState.rotationY,
      stageRotationY: this.cameraState.stageRotationY,
      panOffsetX: this.cameraState.panOffsetX,
      panOffsetY: this.cameraState.panOffsetY,
    };
    const targetRotation = finite(options.rotationY);
    const offset = record(options.cameraOffset);
    const targetOffset = { x: finite(offset.x), y: finite(offset.y) };
    const ownership = this.beginCameraTween(["rotationY", "stageRotationY", "panOffsetX", "panOffsetY"]);
    await this.runSceneTween({
      duration: finite(options.duration),
      ease: options.ease,
      signal: options.signal as AbortSignal | undefined,
      update: (progress) => {
        this.writeCameraTween(ownership, "rotationY", lerp(from.rotationY, targetRotation, progress));
        this.writeCameraTween(ownership, "stageRotationY", lerp(from.stageRotationY, targetRotation, progress));
        this.writeCameraTween(ownership, "panOffsetX", lerp(from.panOffsetX, targetOffset.x, progress));
        this.writeCameraTween(ownership, "panOffsetY", lerp(from.panOffsetY, targetOffset.y, progress));
        this.applyCameraTransform();
      },
    });
  }

  async shakeCommand(...args: unknown[]): Promise<void> {
    const fieldStrength = finite(args[0]);
    const uiStrength = finite(args[1]);
    const duration = Math.max(0, finite(args[2]));
    const vibrato = Math.max(1, finite(args[3], 10));
    const randomness = finite(args[4], 90);
    const fadeOut = args[5] !== false;
    const layers = Array.isArray(args[6]) ? (args[6] as unknown[]).map(Number) : [];
    const layerSet = new Set(layers.length ? layers : [0, 2, 7, 9]);
    const tasks: Promise<void>[] = [];
    if (layerSet.has(0)) {
      tasks.push(this.shakeLayer("background", fieldStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(2)) {
      tasks.push(this.shakeLayer("character", fieldStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(7)) {
      tasks.push(this.shakeLayer("still", uiStrength, duration, vibrato, randomness, fadeOut));
    }
    if (layerSet.has(9)) {
      tasks.push(this.shakeLayer("talk", uiStrength, duration, vibrato, randomness, fadeOut));
    }
    await Promise.all(tasks);
  }

  isCameraShakePlaying(): boolean {
    return this.cameraShakeMode === "playing";
  }

  async enableCameraShake(...args: unknown[]): Promise<void> {
    const strength = Math.max(0, finite(args[0]));
    const cycleSeconds = Math.max(0.001, finite(args[1], 1));
    const vibrato = Math.max(1, finite(args[2], 2));
    const randomness = finite(args[3], 60);
    const fadeDuration = Math.max(0, finite(args[4]));
    if (this.cameraShakeMode === "playing") {
      await wait(this.deterministicReplay ? 0 : fadeDuration);
      return;
    }
    this.cameraShakeController?.abort();
    const controller = new AbortController();
    this.cameraShakeController = controller;
    this.cameraShakeMode = "playing";
    this.cameraShakeStartedAt = nowMilliseconds();
    this.cameraShakeCycleStartedAt = this.cameraShakeStartedAt;
    this.cameraShakeStrength = strength;
    this.cameraShakeCycleSeconds = cycleSeconds;
    this.cameraShakeVibrato = vibrato;
    this.cameraShakeRandomness = randomness;
    this.cameraShakeFadeInSeconds = fadeDuration;
    this.cameraShakeFadeOutSeconds = 0;
    this.cameraShakeWeight = fadeDuration > 0 ? 0 : 1;
    this.cameraShakePath = createAdvDotweenShakePath({
      duration: cycleSeconds,
      strength,
      vibrato,
      randomness,
      fadeOut: false,
      vectorBased: true,
    });
    if (this.root) this.root.dataset.cameraShake = "playing";
    this.scheduleCameraShakeFrame();
    await wait(this.deterministicReplay ? 0 : fadeDuration, controller.signal).catch((error) => {
      if ((error as Error)?.name !== "AbortError") throw error;
    });
  }

  async disableCameraShake(fadeDuration: number): Promise<void> {
    if (this.cameraShakeMode === "idle") return;
    if (this.cameraShakeMode === "stopping") {
      const controller = this.cameraShakeController;
      if (controller) {
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return;
    }
    this.cameraShakeMode = "stopping";
    this.cameraShakeStopStartedAt = nowMilliseconds();
    this.cameraShakeFadeOutSeconds = Math.max(0, finite(fadeDuration));
    if (this.root) this.root.dataset.cameraShake = "stopping";
    const cycles = Math.max(1, Math.ceil(this.cameraShakeFadeOutSeconds / this.cameraShakeCycleSeconds));
    const settleSeconds = cycles * this.cameraShakeCycleSeconds;
    const controller = this.cameraShakeController;
    try {
      await wait(this.deterministicReplay ? 0 : settleSeconds, controller?.signal);
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") throw error;
      return;
    }
    if (controller && this.cameraShakeController !== controller) return;
    this.cameraShakeMode = "idle";
    this.cameraShakeWeight = 0;
    this.cameraShake = { x: 0, y: 0 };
    this.cameraShakeController?.abort();
    this.cameraShakeController = null;
    this.cancelCameraShakeFrame();
    this.root?.removeAttribute("data-camera-shake");
    this.applyCameraTransform();
  }

  startTimedPseudoLipSync(targets: string[] | string): void {
    this.markSpeaking(targets, true);
  }

  startTimedHoldOpenPseudoLipSync(targets: string[] | string): void {
    this.markSpeaking(targets, true);
  }

  startTimedPseudoLipSyncSeconds(targets: string[] | string): void {
    this.markSpeaking(targets, true);
  }

  startVoiceLipSync(targets: string[] | string): boolean {
    this.markSpeaking(targets, true);
    return false;
  }

  stopTimedPseudoLipSync(targets: string[] | string): void {
    this.markSpeaking(targets, false);
  }

  stopAllTimedPseudoLipSync(): void {
    this.stopAllSpeaking();
  }

  stopSpeaking(targets: string[] | string): void {
    this.markSpeaking(targets, false);
  }

  stopAllSpeaking(): void {
    for (const character of this.characters.values()) character.host.removeAttribute("data-speaking");
  }

  seekSnapshotSafety(): SeekSnapshotSafety {
    if (this.video) return { safe: false, reason: "video playback is active" };
    if (this.stageCaptures.size) return { safe: false, reason: "a stage capture transition is active" };
    if (this.ruleTransitionActive) return { safe: false, reason: "a rule transition is active" };
    return { safe: true };
  }

  createSeekSnapshot(): AdvStorySceneSeekSnapshot | null {
    if (!this.seekSnapshotSafety().safe) return null;
    return {
      version: STORY_SCENE_SEEK_SNAPSHOT_VERSION,
      pluginState: JSON.parse(JSON.stringify(this.state.pluginState ?? {})),
      ...(this.state.video.layout ? { videoLayout: JSON.parse(JSON.stringify(this.state.video.layout)) } : {}),
      background: this.background,
      still: this.still,
      frame: this.frame,
      frameName: this.frameName,
      stage: this.stage,
      cameraState: { ...this.cameraState },
      characters: [...this.characters.values()].map((character) => ({
        target: character.target,
        identity: character.identity,
        entry: character.sourceEntry,
        positionType: character.positionType,
        alpha: character.alpha,
        brightness: character.brightness,
        paused: character.paused,
        worldPosition: character.worldPosition ? { ...character.worldPosition } : null,
        offset: { ...character.offset },
        angle: character.angle,
        bodyAngle: character.bodyAngle,
        lookX: character.lookX,
        lookY: character.lookY,
        lookEnabled: character.lookEnabled,
        lookTargetName: character.lookTargetName,
      })),
      rendererState: {
        kind: "vega-generic-dom-v1",
        commandPostEffect: this.commandPostEffect,
        stageEnvironmentIndex: this.stageEnvironmentIndex,
        stageLightIndex: this.stageLightIndex,
        stagePostIndex: this.stagePostIndex,
        stageParticleIndex: this.stageParticleIndex,
        backgroundBrightness: this.backgroundBrightness,
        backgroundBlurIntensity: this.backgroundBlurIntensity,
        characterPriorityOrder: [...this.characterPriorityOrder],
        characters: Object.fromEntries(
          [...this.characters.values()].map((character) => [
            character.target,
            {
              controllerIdentity: character.controllerIdentity,
              blurIntensity: character.blurIntensity,
              currentMotionName: character.currentMotionName,
              currentMotionFadeInSeconds: character.currentMotionFadeInSeconds,
              currentExpressionName: character.currentExpressionName,
              currentExpressionFadeInSeconds: character.currentExpressionFadeInSeconds,
              rimLight: { ...character.rimLight },
            },
          ]),
        ),
        commandEffects: [...this.commandEffects.values()].map(({ key, asset, options }) => ({
          key,
          asset,
          options,
        })),
      } satisfies GenericDomSeekState,
    };
  }

  async restoreSeekSnapshot(snapshot: AdvStorySceneSeekSnapshot): Promise<void> {
    if (snapshot.version !== STORY_SCENE_SEEK_SNAPSHOT_VERSION) throw new Error("Unsupported story scene snapshot");
    this.resetStageCapture();
    this.stopCommandEffects();
    this.resetShakeState();
    this.stopAllSpeaking();
    this.ruleTransitionActive = false;
    this.clearRuleVisual();
    this.stage = snapshot.stage;
    this.state.pluginState = JSON.parse(JSON.stringify(snapshot.pluginState ?? {}));
    this.setVideoLayout(snapshot.videoLayout ? JSON.parse(JSON.stringify(snapshot.videoLayout)) : undefined);
    await this.setBackground(snapshot.background, 0);
    if (snapshot.still) await this.setStill(snapshot.still, 1, 0);
    else await this.clearStill(0);
    if (snapshot.frame) await this.setFrameOverlay(snapshot.frame, 1, snapshot.frameName);
    else this.clearFrameOverlay();
    Object.assign(this.cameraState, snapshot.cameraState);
    this.applyCameraTransform();
    const rendererState = snapshot.rendererState;
    const genericState = isGenericDomSeekState(rendererState) ? rendererState : null;
    const desiredCharacters = new Map(snapshot.characters.map((character) => [character.target, character]));
    for (const [target, current] of this.characters) {
      const desired = desiredCharacters.get(target);
      if (desired && current.identity === desired.identity && current.sourceEntry === record(desired.entry)) {
        continue;
      }
      this.characters.delete(target);
      await this.releaseCharacter(current);
    }
    for (const character of snapshot.characters) {
      if (!this.characters.has(character.target)) {
        await this.placeCharacter(
          {
            command: 0,
            targetName: character.target,
            targets: [{ target: character.target }],
            characterModel: character.entry,
            characterKey: character.identity,
            controllerIdentity: genericState?.characters?.[character.target]?.controllerIdentity,
          },
          character.positionType,
          0,
        );
      }
      const restored = this.characters.get(character.target);
      if (!restored) continue;
      restored.positionType = character.positionType;
      restored.worldPosition = character.worldPosition;
      restored.offset = { ...character.offset };
      restored.paused = character.paused;
      restored.pendingPausedMotion = null;
      restored.pendingPausedExpression = null;
      restored.blurIntensity = 0;
      restored.currentMotionName = "";
      restored.currentMotionFadeInSeconds = 0;
      restored.currentExpressionName = "";
      restored.currentExpressionFadeInSeconds = 0;
      restored.rimLight = {
        enabled: false,
        color: "transparent",
        shadowIntensity: 0,
      };
      restored.host.removeAttribute("data-motion");
      restored.host.removeAttribute("data-expression");
      restored.model.setPaused(character.paused);
      restored.angle = finite(character.angle);
      restored.bodyAngle = finite(character.bodyAngle);
      restored.lookX = finite(character.lookX);
      restored.lookY = finite(character.lookY);
      restored.lookEnabled = Boolean(character.lookEnabled);
      restored.lookTargetName = firstString(character.lookTargetName);
      this.applyCharacterTransform(restored);
      this.applyCharacterPortraitTransform(restored);
      if (restored.lookEnabled) {
        restored.host.dataset.look = `${restored.lookX},${restored.lookY}`;
        if (restored.lookTargetName) restored.host.dataset.lookTarget = restored.lookTargetName;
        else restored.host.removeAttribute("data-look-target");
      } else {
        restored.host.removeAttribute("data-look");
        restored.host.removeAttribute("data-look-target");
      }
      restored.host.dataset.angle = String(restored.angle);
      restored.host.dataset.bodyAngle = String(restored.bodyAngle);
      await this.setBrightness(character.target, character.brightness, 0);
      await this.fadeCharacter(character.target, character.alpha, 0);
    }
    if (genericState) {
      this.backgroundBrightness = clamp(genericState.backgroundBrightness ?? 1);
      this.backgroundBlurIntensity = clamp(genericState.backgroundBlurIntensity ?? 0);
      this.applyBackgroundFilter();
      this.characterPriorityOrder = Array.isArray(genericState.characterPriorityOrder)
        ? genericState.characterPriorityOrder.map((value) => Math.trunc(finite(value)))
        : [4, 0, 3, 1, 2];
      for (const character of this.characters.values()) {
        const saved = genericState.characters?.[character.target];
        if (!saved) continue;
        character.blurIntensity = clamp(saved.blurIntensity);
        character.currentMotionName = firstString(saved.currentMotionName);
        character.currentMotionFadeInSeconds = finite(saved.currentMotionFadeInSeconds);
        character.currentExpressionName = firstString(saved.currentExpressionName);
        character.currentExpressionFadeInSeconds = finite(saved.currentExpressionFadeInSeconds);
        if (character.currentMotionName) {
          character.host.dataset.motion = character.currentMotionName;
        }
        if (character.currentExpressionName) {
          character.host.dataset.expression = character.currentExpressionName;
        }
        character.rimLight = {
          enabled: Boolean(saved.rimLight?.enabled),
          color: saved.rimLight?.color,
          shadowIntensity: Math.max(0, finite(saved.rimLight?.shadowIntensity)),
        };
        this.applyCharacterFilter(character);
        this.applyCharacterPresentation(character);
      }
      this.applyCharacterPriorities();
      this.applyStageEnv(genericState.stageEnvironmentIndex);
      this.applyStageLight(genericState.stageLightIndex);
      this.applyStagePostEffect(genericState.stagePostIndex);
      this.changeStageParticleEffects(genericState.stageParticleIndex);
      if (genericState.commandPostEffect != null) {
        await this.setCommandPostEffect(genericState.commandPostEffect, 0);
      } else {
        await this.clearCommandPostEffects(0);
      }
      for (const effect of genericState.commandEffects) {
        this.mountCommandEffect(effect.key, effect.asset, effect.options);
      }
    } else {
      await this.clearCommandPostEffects(0);
      this.applyStageLight(0);
      this.applyStagePostEffect(0);
      this.changeStageParticleEffects(0);
    }
  }

  async settleSeekSnapshotResources(): Promise<void> {
    await Promise.allSettled([...this.pendingLoads]);
  }

  private track<T>(pending: Promise<T>): Promise<T> {
    this.pendingLoads.add(pending);
    void pending.then(
      () => this.pendingLoads.delete(pending),
      () => this.pendingLoads.delete(pending),
    );
    return pending;
  }

  private createCharacterHost(target: string, providerId: string, model: StoryCharacterModel): HTMLDivElement {
    const host = document.createElement("div");
    host.className = "vega-stage__character";
    host.dataset.vegaCharacter = target;
    host.dataset.vegaCharacterProvider = providerId;
    host.style.cssText =
      "position:absolute;bottom:0;height:96%;max-width:70%;opacity:0;filter:brightness(1);transform:translateX(-50%);transform-origin:center bottom;will-change:transform,opacity,filter;";
    host.append(model.element);
    return host;
  }

  private async disposeCharacterModel(model: StoryCharacterModel | null | undefined): Promise<void> {
    if (!model || this.disposedCharacterModels.has(model)) return;
    this.disposedCharacterModels.add(model);
    await model.dispose();
  }

  private async releaseCharacter(character: CharacterRecord): Promise<void> {
    character.host.remove();
    character.host.removeAttribute("data-speaking");
    character.model.setPaused(true);
    if (
      character.provider &&
      !character.compilationOnly &&
      !this.destroyed &&
      character.model.isOperational !== false
    ) {
      const resident = this.preloadedCharacters.get(character.controllerIdentity);
      if (!resident) {
        this.preloadedCharacters.set(character.controllerIdentity, {
          identity: character.controllerIdentity,
          target: character.target,
          provider: character.provider,
          sourceEntry: character.sourceEntry,
          model: character.model,
          host: character.host,
        });
        return;
      }
      if (resident.model === character.model) return;
    }
    await this.disposeCharacterModel(character.model);
  }

  private createEffectSurface(name: string): HTMLDivElement {
    const surface = document.createElement("div");
    surface.className = `vega-stage__${name}`;
    surface.dataset.vegaEffectSurface = name;
    surface.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;opacity:0;";
    return surface;
  }

  private clearRuleVisual(): void {
    if (!this.coverLayer) return;
    this.coverLayer.removeAttribute("data-rule-transition");
    this.coverLayer.style.backgroundImage = "";
    this.coverLayer.style.backgroundColor = "";
    this.coverLayer.style.clipPath = "";
    this.coverLayer.style.transition = "none";
  }

  private commandPostVisual(profile: unknown): {
    readonly filter: string;
    readonly overlay: string;
    readonly blendMode: string;
    readonly opacity: number;
  } {
    const name = visualName(profile).toLowerCase();
    const source = record(profile);
    const components = Object.keys(record(source.components)).join(" ").toLowerCase();
    const signature = `${name} ${components}`;
    if (/mono|gray|greyscale|black.?white/.test(signature)) {
      return {
        filter: "grayscale(1) contrast(1.08)",
        overlay: "radial-gradient(circle, transparent 48%, rgb(0 0 0 / .38))",
        blendMode: "multiply",
        opacity: 0.72,
      };
    }
    if (/sepia|warm|sunset/.test(signature)) {
      return {
        filter: "sepia(.38) saturate(1.16) contrast(1.04)",
        overlay: "linear-gradient(135deg, rgb(255 181 92 / .2), rgb(124 39 18 / .12))",
        blendMode: "soft-light",
        opacity: 0.7,
      };
    }
    if (/night|cold|blue|moon/.test(signature)) {
      return {
        filter: "brightness(.74) saturate(.82) hue-rotate(12deg)",
        overlay: "linear-gradient(160deg, rgb(33 72 146 / .24), rgb(8 16 50 / .36))",
        blendMode: "multiply",
        opacity: 0.86,
      };
    }
    if (/blur|dream|bloom|glow/.test(signature)) {
      return {
        filter: "saturate(1.2) contrast(1.04) brightness(1.06)",
        overlay: "radial-gradient(circle at 50% 38%, rgb(255 255 255 / .2), transparent 58%)",
        blendMode: "screen",
        opacity: 0.9,
      };
    }
    if (/vignette/.test(signature)) {
      return {
        filter: "contrast(1.07) saturate(.94)",
        overlay: "radial-gradient(ellipse at center, transparent 42%, rgb(0 0 0 / .58) 100%)",
        blendMode: "multiply",
        opacity: 1,
      };
    }
    const hue = stableHash(signature) % 360;
    return {
      filter: `saturate(1.08) contrast(1.035) hue-rotate(${(hue % 17) - 8}deg)`,
      overlay: `linear-gradient(145deg, hsl(${hue} 74% 54% / .1), hsl(${(hue + 84) % 360} 62% 38% / .08))`,
      blendMode: "soft-light",
      opacity: 0.74,
    };
  }

  private mountCommandEffect(
    key: string,
    asset: AdvEffectEntry | null,
    options: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.commandEffectLayer || this.commandEffects.has(key)) return;
    const element = document.createElement("div");
    const source = record(asset);
    const runtime = record(source.runtime);
    const positionType = finite(options.positionType, 5);
    const hue = stableHash(firstString(source.name, source.source, key)) % 360;
    const color = colorCss(source.color ?? runtime.color, `hsl(${hue} 92% 68%)`);
    element.className = "vega-stage__command-effect";
    element.dataset.effectKey = key;
    element.dataset.effectName = firstString(source.name, source.source, key);
    element.dataset.effectRoute = this.characterStageIndex(positionType) >= 0 ? "character-stage" : "screen";
    element.style.cssText =
      "position:absolute;width:min(34vw,34vh);aspect-ratio:1;border-radius:999px;pointer-events:none;will-change:transform,opacity;";
    element.style.left = `${this.positionPercent(positionType)}%`;
    element.style.top = element.dataset.effectRoute === "character-stage" ? "62%" : "48%";
    element.style.background = `radial-gradient(circle, ${color} 0 7%, color-mix(in srgb, ${color} 42%, transparent) 24%, transparent 68%), repeating-conic-gradient(from 8deg, color-mix(in srgb, ${color} 26%, transparent) 0 3deg, transparent 3deg 18deg)`;
    element.style.filter = `drop-shadow(0 0 18px ${color})`;
    element.style.mixBlendMode = "screen";
    const effect: CommandEffectRecord = { key, asset, options: { ...options, key }, element };
    this.applyCommandEffectAnimation(effect);
    this.commandEffectLayer.append(element);
    this.commandEffectLayer.style.opacity = "1";
    this.commandEffects.set(key, effect);
  }

  private applyCommandEffectAnimation(effect: CommandEffectRecord): void {
    const speed = Math.max(0.05, finite(effect.options.simulationSpeed, this.playbackSpeed));
    effect.element.style.animation = this.deterministicReplay
      ? "none"
      : `vega-generic-effect-pulse ${1.4 / speed}s ease-in-out infinite`;
    if (this.deterministicReplay) {
      effect.element.style.transform = "translate(-50%, -50%)";
      effect.element.style.opacity = ".72";
    }
  }

  private renderStageParticles(): void {
    const layer = this.particleLayer;
    if (!layer) return;
    layer.replaceChildren();
    if (!this.stageParticleIndex) {
      layer.style.opacity = "0";
      return;
    }
    const seed = Math.abs(this.stageParticleIndex);
    const kind = seed % 3;
    const count = 10 + (seed % 7);
    layer.style.opacity = "1";
    for (let index = 0; index < count; index += 1) {
      const particle = document.createElement("span");
      const x = (stableHash(`${seed}:x:${index}`) % 1000) / 10;
      const y = (stableHash(`${seed}:y:${index}`) % 1000) / 10;
      const size = 2 + (stableHash(`${seed}:size:${index}`) % 7);
      const hue = stableHash(`${seed}:hue`) % 360;
      particle.dataset.particle = String(index);
      particle.style.cssText = "position:absolute;display:block;pointer-events:none;will-change:transform,opacity;";
      particle.style.left = `${x}%`;
      particle.style.top = `${y}%`;
      particle.style.width = `${kind === 2 ? Math.max(1, size / 3) : size}px`;
      particle.style.height = `${kind === 2 ? size * 3 : size}px`;
      particle.style.borderRadius = "999px";
      particle.style.background =
        kind === 1 ? `hsl(${hue} 94% 76% / .88)` : kind === 2 ? "rgb(255 255 255 / .72)" : `hsl(${hue} 68% 84% / .62)`;
      particle.style.boxShadow = kind === 1 ? `0 0 ${size * 2}px hsl(${hue} 94% 72% / .8)` : "";
      const duration = (5 + (stableHash(`${seed}:duration:${index}`) % 60) / 10) / this.playbackSpeed;
      const animation =
        kind === 0
          ? "vega-generic-particle-drift"
          : kind === 1
            ? "vega-generic-particle-rise"
            : "vega-generic-particle-fall";
      particle.style.animation = this.deterministicReplay
        ? "none"
        : `${animation} ${duration}s linear ${-(index * 0.47)}s infinite`;
      layer.append(particle);
    }
  }

  private applyCharacterTransform(character: CharacterRecord): void {
    const x = character.worldPosition
      ? 50 + character.worldPosition.x * this.worldUnitPercent()
      : this.positionPercent(character.positionType) + character.offset.x * this.worldUnitPercent();
    const y = character.worldPosition ? character.worldPosition.y : character.offset.y;
    const z = character.worldPosition ? character.worldPosition.z : character.offset.z;
    character.host.style.left = `${x}%`;
    character.host.style.bottom = `${y * this.worldUnitPercent()}%`;
    character.host.style.transform = `translateX(-50%) translateZ(${z}px) rotate(${
      clamp((character.bodyAngle + 30) / 60) * 60 - 30
    }deg)`;
    character.host.style.opacity = String(character.alpha);
  }

  private applyCharacterPortraitTransform(character: CharacterRecord): void {
    // A dynamic provider owns its model surface and receives the same values
    // through applyPresentation. Do not impose the static-portrait CSS
    // approximation on its canvas/DOM transform a second time.
    if (typeof character.model.applyPresentation === "function") return;
    const gazeX = character.lookEnabled ? normalizedDirection(character.lookX) : 0;
    const gazeY = character.lookEnabled ? normalizedDirection(character.lookY) : 0;
    const faceAngle = clamp((character.angle + 24) / 48) * 48 - 24;
    character.model.element.style.transform = `translate(${cssNumber(gazeX * 2.2)}%, ${cssNumber(
      gazeY * -1.6,
    )}%) rotate(${cssNumber(faceAngle)}deg) scale(${character.lookEnabled ? 1.012 : 1})`;
  }

  private applyCameraTransform(): void {
    if (!this.root) return;
    const unit = this.worldUnitPercent();
    const cameraX = -(this.cameraState.baseX + this.cameraState.panOffsetX + this.cameraShake.x) * unit;
    const cameraY = -(this.cameraState.baseY + this.cameraShake.y) * unit;
    const depthScale = Math.max(0.5, 1 + (this.cameraState.baseZ + this.cameraState.panOffsetY) / 12);
    const scale = Math.max(0.001, this.cameraState.zoomRatio * depthScale);
    const common = `perspective(1200px) translate3d(${cssNumber(cameraX)}%, ${cssNumber(
      cameraY,
    )}%, 0) rotateX(${cssNumber(-this.cameraState.rotationX)}deg) rotateY(${cssNumber(
      -this.cameraState.rotationY,
    )}deg) rotateZ(${cssNumber(-this.cameraState.angle)}deg) scale(${cssNumber(scale)})`;
    const fieldRotation = ` rotateY(${cssNumber(this.cameraState.fieldRotationY)}deg)`;
    const backgroundShake = ` translate3d(${cssNumber(this.backgroundShake.x * unit)}%, ${cssNumber(
      -this.backgroundShake.y * unit,
    )}%, 0)`;
    const characterShake = ` translate3d(${cssNumber(this.characterShake.x * unit)}%, ${cssNumber(
      -this.characterShake.y * unit,
    )}%, 0)`;
    if (this.backgroundLayer) {
      this.backgroundLayer.style.transformOrigin = "50% 50%";
      this.backgroundLayer.style.transform = `${common}${fieldRotation}${backgroundShake}`;
    }
    if (this.characterLayer) {
      this.characterLayer.style.transformOrigin = "50% 50%";
      this.characterLayer.style.transform = `${common}${fieldRotation} rotateY(${cssNumber(
        this.cameraState.stageRotationY,
      )}deg)${characterShake}`;
    }
    if (this.effectsLayer) {
      this.effectsLayer.style.transformOrigin = "50% 50%";
      this.effectsLayer.style.transform = `${common}${fieldRotation}`;
    }
    this.root.dataset.cameraBase = `${cssNumber(this.cameraState.baseX)},${cssNumber(
      this.cameraState.baseY,
    )},${cssNumber(this.cameraState.baseZ)}`;
    this.root.dataset.cameraPanOffset = `${cssNumber(this.cameraState.panOffsetX)},${cssNumber(
      this.cameraState.panOffsetY,
    )}`;
    this.root.dataset.cameraRotation = `${cssNumber(this.cameraState.rotationX)},${cssNumber(
      this.cameraState.rotationY,
    )},${cssNumber(this.cameraState.angle)}`;
    this.root.dataset.fieldRotationY = String(cssNumber(this.cameraState.fieldRotationY));
    this.root.dataset.stageRotationY = String(cssNumber(this.cameraState.stageRotationY));
    this.root.dataset.cameraZoom = String(cssNumber(this.cameraState.zoomRatio));
  }

  private worldUnitPercent(): number {
    return 84 / Math.max(0.001, finite(this.runtime.stage.width, 3.2));
  }

  private positionPercent(positionType: number): number {
    const point = this.focusPoint(positionType);
    const minimum = finite(this.runtime.stage.minX, -1.6);
    const maximum = finite(this.runtime.stage.maxX, 1.6);
    if (maximum > minimum && Number.isFinite(point.x)) {
      return 8 + clamp((point.x - minimum) / (maximum - minimum)) * 84;
    }
    return positionPercent(positionType);
  }

  private applyCharacterFilter(character: CharacterRecord): void {
    const filters = [
      `brightness(${cssNumber(clamp(character.brightness))})`,
      character.blurIntensity > 0 ? `blur(${cssNumber(clamp(character.blurIntensity) * 12)}px)` : "",
      character.rimLight.enabled
        ? `drop-shadow(0 0 ${cssNumber(character.rimLight.shadowIntensity * 12)}px ${colorCss(
            character.rimLight.color,
            "transparent",
          )})`
        : "",
    ].filter(Boolean);
    character.host.style.filter = filters.join(" ");
  }

  private applyBackgroundFilter(): void {
    if (!this.backgroundImage) return;
    this.backgroundImage.style.filter = [
      `brightness(${cssNumber(clamp(this.backgroundBrightness))})`,
      this.backgroundBlurIntensity > 0
        ? `blur(${cssNumber(clamp(this.backgroundBlurIntensity) * 12)}px) scale(${cssNumber(
            1 + clamp(this.backgroundBlurIntensity) * 0.025,
          )})`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private applyCharacterPresentation(character: CharacterRecord): void {
    const presentation: StoryCharacterPresentation = {
      alpha: character.alpha,
      brightness: character.brightness,
      blurIntensity: character.blurIntensity,
      angle: character.angle,
      bodyAngle: character.bodyAngle,
      lookX: character.lookX,
      lookY: character.lookY,
      lookEnabled: character.lookEnabled,
      lookTargetName: character.lookTargetName,
      paused: character.paused,
      playbackSpeed: this.playbackSpeed,
      motionName: character.currentMotionName,
      expressionName: character.currentExpressionName,
      rimLight: { ...character.rimLight },
    };
    try {
      const result = character.model.applyPresentation?.(presentation);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch((error) => {
          console.warn(`[Vega] character provider presentation failed for ${character.target}`, error);
        });
      }
    } catch (error) {
      console.warn(`[Vega] character provider presentation failed for ${character.target}`, error);
    }
  }

  private hasCharacterAnimation(character: CharacterRecord, kind: "motion" | "expression", name: string): boolean {
    const entries =
      kind === "motion" ? advCharacterMotions(character.sourceEntry) : advCharacterExpressions(character.sourceEntry);
    if (!entries.length) return true;
    return entries.some((entry) => firstString(entry.name, entry.key, entry.source) === name);
  }

  private characterStageIndex(positionType: number): number {
    const value = Math.trunc(finite(positionType));
    return value >= 1 && value <= 9 && value % 2 === 1 ? (value - 1) / 2 : -1;
  }

  private characterPriority(positionType: number): number {
    const index = this.characterStageIndex(positionType);
    if (index < 0) return this.characterPriorityOrder.length;
    const priority = this.characterPriorityOrder.indexOf(index);
    return priority >= 0 ? priority : this.characterPriorityOrder.length;
  }

  private applyCharacterPriorities(): void {
    for (const character of this.characters.values()) {
      character.host.style.zIndex = String(this.characterPriority(character.positionType) + 1);
    }
  }

  private async setStillViewAlpha(backgroundAlpha: number, overlayAlpha: number, duration: number): Promise<void> {
    const visualDuration = this.deterministicReplay ? 0 : Math.max(0, finite(duration));
    await Promise.all([
      this.stillBackdrop
        ? setTransition(this.stillBackdrop, "opacity", String(clamp(backgroundAlpha)), visualDuration)
        : Promise.resolve(),
      this.stillShade
        ? setTransition(this.stillShade, "opacity", String(clamp(overlayAlpha)), visualDuration)
        : Promise.resolve(),
    ]);
  }

  private applyStillAnimation(image: HTMLImageElement, animationIndex: number, duration: number): void {
    const scale = animationIndex % 3 === 1 ? 1.06 : animationIndex % 3 === 2 ? 1.12 : 1;
    const translateX = animationIndex % 4 === 3 ? -2.5 : animationIndex % 4 === 2 ? 2.5 : 0;
    image.style.transition =
      !this.deterministicReplay && duration > 0 ? `transform ${duration}s cubic-bezier(.22,.61,.36,1)` : "none";
    image.style.transform = `translateX(${translateX}%) scale(${scale})`;
  }

  private beginCameraTween(keys: readonly (keyof StoryCameraState)[]): Map<keyof StoryCameraState, number> {
    const ownership = new Map<keyof StoryCameraState, number>();
    for (const key of keys) {
      const version = (this.cameraTweenVersions.get(key) ?? 0) + 1;
      this.cameraTweenVersions.set(key, version);
      ownership.set(key, version);
    }
    return ownership;
  }

  private writeCameraTween(
    ownership: ReadonlyMap<keyof StoryCameraState, number>,
    key: keyof StoryCameraState,
    value: number,
  ): void {
    if (ownership.get(key) !== this.cameraTweenVersions.get(key)) return;
    (this.cameraState as unknown as Record<string, unknown>)[key] = value;
  }

  private async runSceneTween(options: {
    readonly duration: number;
    readonly ease?: unknown;
    readonly signal?: AbortSignal;
    readonly update: (progress: number) => void;
  }): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.sceneController.signal.addEventListener("abort", abort, { once: true });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (this.sceneController.signal.aborted || options.signal?.aborted) controller.abort();
    try {
      await tween({
        duration: this.deterministicReplay ? 0 : Math.max(0, finite(options.duration)),
        ease: resolveEase(options.ease, 6),
        signal: controller.signal,
        update: (progress) => options.update(progress),
      });
    } finally {
      this.sceneController.signal.removeEventListener("abort", abort);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private shakeLayer(
    kind: "background" | "character" | "still" | "talk",
    strength: number,
    duration: number,
    vibrato: number,
    randomness: number,
    fadeOut: boolean,
  ): Promise<void> {
    this.commandShakeControllers.get(kind)?.abort();
    this.resetCommandShake(kind);
    const controller = new AbortController();
    this.commandShakeControllers.set(kind, controller);
    const startedAt = nowMilliseconds();
    const path = createAdvDotweenShakePath({
      duration,
      strength,
      vibrato,
      randomness,
      fadeOut,
      vectorBased: kind === "background" || kind === "character",
    });
    return this.runSceneTween({
      duration,
      ease: 1,
      signal: controller.signal,
      update: (progress) => {
        // runSceneTween receives eased linear progress; DOTween shake owns its
        // own segmented easing/path.
        const wallClockProgress = duration <= 0 ? 1 : clamp((nowMilliseconds() - startedAt) / 1000 / duration);
        const sample = sampleAdvDotweenShake(
          path,
          this.deterministicReplay ? 1 : Math.max(progress, wallClockProgress),
        );
        if (kind === "background") this.backgroundShake = sample;
        else if (kind === "character") this.characterShake = sample;
        else if (kind === "still") this.applyStillShake(sample);
        else {
          const uiScale = Math.max(0, finite(this.state.viewport?.height, 1080)) / 1080 || 1;
          if (this.state.talk) {
            this.state.talk.shakeX = sample.x * uiScale;
            this.state.talk.shakeY = sample.y * uiScale;
          }
        }
        this.applyCameraTransform();
      },
    }).finally(() => {
      if (this.commandShakeControllers.get(kind) !== controller) return;
      this.commandShakeControllers.delete(kind);
      this.resetCommandShake(kind);
      this.applyCameraTransform();
    });
  }

  private applyStillShake(offset: StoryPoint2): void {
    if (!this.stillLayer) return;
    const uiScale = Math.max(0, finite(this.state.viewport?.height, 1080)) / 1080 || 1;
    this.stillLayer.style.transform = `translate(${cssNumber(offset.x * uiScale)}px, ${cssNumber(
      offset.y * uiScale,
    )}px)`;
  }

  private resetCommandShake(kind: "background" | "character" | "still" | "talk"): void {
    if (kind === "background") this.backgroundShake = { x: 0, y: 0 };
    else if (kind === "character") this.characterShake = { x: 0, y: 0 };
    else if (kind === "still") this.applyStillShake({ x: 0, y: 0 });
    else if (this.state.talk) {
      this.state.talk.shakeX = 0;
      this.state.talk.shakeY = 0;
    }
  }

  private scheduleCameraShakeFrame(): void {
    if (this.cameraShakeFrame != null || this.cameraShakeMode === "idle" || this.destroyed) return;
    const tick = () => {
      this.cameraShakeFrame = null;
      if (this.cameraShakeMode === "idle" || this.destroyed) return;
      const now = nowMilliseconds();
      const cycleMilliseconds = this.cameraShakeCycleSeconds * 1000;
      if (now - this.cameraShakeCycleStartedAt >= cycleMilliseconds) {
        this.cameraShakeCycleStartedAt = now;
        this.cameraShakePath = createAdvDotweenShakePath({
          duration: this.cameraShakeCycleSeconds,
          strength: this.cameraShakeStrength,
          vibrato: this.cameraShakeVibrato,
          randomness: this.cameraShakeRandomness,
          fadeOut: false,
          vectorBased: true,
        });
      }
      if (this.cameraShakeMode === "playing") {
        this.cameraShakeWeight =
          this.cameraShakeFadeInSeconds > 0
            ? clamp((now - this.cameraShakeStartedAt) / (this.cameraShakeFadeInSeconds * 1000))
            : 1;
      } else {
        this.cameraShakeWeight =
          this.cameraShakeFadeOutSeconds > 0
            ? clamp(1 - (now - this.cameraShakeStopStartedAt) / (this.cameraShakeFadeOutSeconds * 1000))
            : 0;
      }
      const progress = clamp((now - this.cameraShakeCycleStartedAt) / cycleMilliseconds);
      const sample = sampleAdvDotweenShake(this.cameraShakePath, progress);
      this.cameraShake = {
        x: sample.x * this.cameraShakeWeight,
        y: sample.y * this.cameraShakeWeight,
      };
      this.applyCameraTransform();
      this.scheduleCameraShakeFrame();
    };
    const view = this.root?.ownerDocument.defaultView;
    this.cameraShakeFrame =
      typeof view?.requestAnimationFrame === "function" ? view.requestAnimationFrame(tick) : setTimeout(tick, 16);
  }

  private cancelCameraShakeFrame(): void {
    if (this.cameraShakeFrame == null) return;
    const view = this.root?.ownerDocument.defaultView;
    if (typeof view?.cancelAnimationFrame === "function" && typeof this.cameraShakeFrame === "number") {
      view.cancelAnimationFrame(this.cameraShakeFrame);
    } else {
      clearTimeout(this.cameraShakeFrame as ReturnType<typeof setTimeout>);
    }
    this.cameraShakeFrame = null;
  }

  private resetShakeState(): void {
    for (const controller of this.commandShakeControllers.values()) controller.abort();
    this.commandShakeControllers.clear();
    for (const kind of ["background", "character", "still", "talk"] as const) this.resetCommandShake(kind);
    this.cameraShakeController?.abort();
    this.cameraShakeController = null;
    this.cameraShakeMode = "idle";
    this.cameraShakeWeight = 0;
    this.cameraShake = { x: 0, y: 0 };
    this.cancelCameraShakeFrame();
    this.root?.removeAttribute("data-camera-shake");
    this.applyCameraTransform();
  }

  private markSpeaking(targets: string[] | string, speaking: boolean): void {
    const names = Array.isArray(targets) ? targets : [targets];
    for (const target of names) {
      const character = this.characters.get(target);
      if (!character) continue;
      if (speaking) character.host.dataset.speaking = "true";
      else character.host.removeAttribute("data-speaking");
    }
  }

  private async createPreloadedImage(source: string, signal?: AbortSignal): Promise<HTMLImageElement> {
    await this.preloadDomImage(source, signal);
    if (signal?.aborted || this.destroyed) throw abortError();
    const prepared = this.preloadedImages.get(source);
    if (!prepared) {
      throw new Error(`Image preload did not retain a decoded template: ${source}`);
    }
    const image = prepared.template.cloneNode(false) as HTMLImageElement;
    image.src = prepared.lease.url;
    image.decoding = "async";
    image.draggable = false;
    return image;
  }

  private async waitForMedia(image: HTMLImageElement, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (image.complete && image.naturalWidth > 0) return;
    await new Promise<void>((resolve, reject) => {
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error(`Image could not be decoded: ${image.src}`));
      };
      const aborted = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        image.removeEventListener("load", loaded);
        image.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      image.addEventListener("load", loaded, { once: true });
      image.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
      else if (image.complete) {
        if (image.naturalWidth > 0) loaded();
        else failed();
      }
    });
  }

  private async waitForVideoReady(
    video: HTMLVideoElement,
    minimumReadyState: number,
    event: "loadeddata" | "canplay",
    signal?: AbortSignal,
  ): Promise<void> {
    if (video.readyState >= minimumReadyState) return;
    await new Promise<void>((resolve, reject) => {
      const loaded = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error(`Video metadata could not be decoded: ${video.src}`));
      };
      const aborted = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        video.removeEventListener(event, loaded);
        video.removeEventListener("error", failed);
        signal?.removeEventListener("abort", aborted);
      };
      video.addEventListener(event, loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
    });
  }

  private releaseLease(kind: "background" | "still" | "frame" | "video"): void {
    const key = `${kind}Lease` as const;
    this[key]?.release();
    this[key] = null;
  }
}
