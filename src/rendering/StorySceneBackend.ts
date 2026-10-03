import type { StoryResourceResolver } from "../resources/StoryResourcePort";
export type { StoryResourceLease, StoryResourceResolver } from "../resources/StoryResourcePort";
import type { StoryScreenEffectDefinition } from "./StoryScreenEffects";
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
  AdvStory,
  AdvStillEntry,
  AdvVideoEntry,
} from "../types/AdvRuntime";
import type { AdvStorySceneSeekSnapshot, SeekSnapshotSafety } from "./neutral/StorySceneSnapshot";
import type { StoryCharacterProvider } from "./StoryCharacterModel";
import type { StoryRendererExtensionRegistry } from "./StoryRendererExtensions";
import type { VegaVoiceAnalysisSource } from "../sound/VoiceAnalysis";
import type { StoryResourceDeclaration } from "../resources/StoryResourcePreparation";

export interface StoryPoint2 {
  x: number;
  y: number;
}

export interface StoryPoint3 extends StoryPoint2 {
  z: number;
}

export interface StoryCameraState {
  rotationY: number;
  fieldRotationY: number;
  stageRotationY: number;
  rotationX: number;
  angle: number;
  zoomRatio: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  panOffsetX: number;
  panOffsetY: number;
  focusPositionType: number;
  focusTargetName: string;
}

export interface StoryCharacterHandle {
  readonly target: string;
  positionType: number;
}

/**
 * Renderer-ready character warmup request.
 *
 * The command contains the already-resolved model variant and stable target
 * asset index. Animation names are derived from authored commands; renderers
 * must not expand them to the provider's complete animation catalogue.
 */
export interface StoryCharacterPreloadRequest {
  readonly command: AdvCommand;
  /** Top-level story command containing this controller's first reachable In. */
  readonly commandIndex: number;
  /**
   * Number of distinct controller identities referenced by this episode.
   * Renderers use this to reserve the complete episode warm set instead of
   * applying a rolling cache limit that would strand later controllers.
   */
  readonly episodeControllerCount: number;
  readonly positionType: number;
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
}

export interface StorySceneBackendContext {
  readonly runtime: AdvRuntimeConfig;
  readonly state: AdvPlayerState;
  readonly resources: StoryResourceResolver;
  readonly characterProviders?: readonly StoryCharacterProvider[];
  /**
   * Active renderer effects and typed host services captured for this player.
   * Direct backend consumers may omit the registry when no extensions exist.
   */
  readonly rendererExtensions?: StoryRendererExtensionRegistry;
  readonly signal: AbortSignal;
}

export interface StoryScenePreviewOptions {
  readonly width: number;
  readonly height: number;
  readonly format: "image/png" | "image/jpeg" | "image/webp";
  readonly quality?: number;
}

/**
 * Stable command-to-renderer port.
 *
 * The default implementation renders backgrounds, static portraits, overlays,
 * transitions, and video using browser primitives. Plugins can replace the
 * complete backend without changing the opcode interpreter.
 */
export interface StorySceneBackend {
  readonly screenEffectKeys?: readonly string[];
  setScreenEffect?(key: string, definition: StoryScreenEffectDefinition, signal?: AbortSignal): Promise<void>;
  clearScreenEffects?(key?: string): void;

  readonly cameraState: StoryCameraState;
  /** Scene-unit transforms around the fixed calibration frame; rotations are radians. */
  readSceneTransform?(target: string):
    | {
        readonly current: Readonly<Record<string, number>>;
        readonly planned: Readonly<Record<string, number>>;
      }
    | undefined;
  writeSceneTransform?(
    target: string,
    value: {
      readonly current: Readonly<Record<string, number>>;
      readonly planned: Readonly<Record<string, number>>;
    },
  ): void;
  readonly screenTransformChannels?: readonly string[];
  clearSceneTransform?(target: string): void;
  clearScreenTransform?(target: string): void;
  setVideoLayout?(layout?: import("../types/AdvRuntime").StoryVideoLayout): void;
  readScreenTransform?(target: string):
    | {
        readonly current: Readonly<Record<string, number>>;
        readonly planned: Readonly<Record<string, number>>;
      }
    | undefined;
  writeScreenTransform?(
    target: string,
    value: {
      readonly current: Readonly<Record<string, number>>;
      readonly planned: Readonly<Record<string, number>>;
    },
  ): void;

  /**
   * Prepare provider-owned renderer runtimes before the scene creates graphics
   * resources. Provider-owned model hosts use this hook to load their core
   * before WebGL model construction; the portable renderer does not need it.
   */
  prepare?(story: AdvStory): void | Promise<void>;
  /** Prepare renderer extensions referenced anywhere in the current story. */
  prepareStoryResources?(story: AdvStory, signal?: AbortSignal): void | Promise<void>;
  /** Enumerate renderer-extension leaf resources before the first frame. */
  enumerateStoryResources?(
    story: AdvStory,
    signal?: AbortSignal,
  ): readonly StoryResourceDeclaration[] | Promise<readonly StoryResourceDeclaration[]>;
  setup(mount: HTMLElement): Promise<void>;
  destroy(options?: { releaseTextures?: boolean }): void | Promise<void>;
  detachState(state: AdvPlayerState): void;
  resize(): void;
  setDeterministicReplayActive(active: boolean): void;
  /** Keep checkpoint compilation from consuming episode-resident models. */
  setSeekIndexCompilationActive?(active: boolean): void;

  preloadTexture(url: string, signal?: AbortSignal): Promise<unknown>;
  loadTexture(url: string, signal?: AbortSignal): Promise<unknown>;
  /** Reserve renderer cache ownership for the complete episode texture set. */
  reservePreloadedTextures?(count: number): void;
  /** Prepare and retain a video element until its first authored playback. */
  preloadVideo?(url: string, signal?: AbortSignal): Promise<unknown>;
  /**
   * Optional renderer-owned warmup that resolves only after a character can
   * produce its first frame in this scene's graphics context.
   */
  preloadCharacter?(request: StoryCharacterPreloadRequest, signal?: AbortSignal): Promise<unknown>;
  /** Report renderer-ready identities discarded by a renderer lifecycle event. */
  advanceCharacterPreload?(commandIndex: number, retainBehindCommands: number): readonly string[] | void;

  createSeekSnapshot(): AdvStorySceneSeekSnapshot | null;
  /**
   * Optional renderer-owned stage capture. Backends that own pixels should
   * implement this instead of making the shell inspect renderer internals.
   */
  capturePreview?(options: StoryScenePreviewOptions): string | undefined | Promise<string | undefined>;
  restoreSeekSnapshot(snapshot: AdvStorySceneSeekSnapshot, signal?: AbortSignal): Promise<void>;
  cancelTransitionsForSeek?(): void;
  presentSeekSnapshot?(): void;
  settleSeekSnapshotResources(): Promise<void>;
  seekSnapshotSafety(): SeekSnapshotSafety;

  stagePoint(positionType: unknown): StoryPoint3;
  focusPoint(positionType: unknown): StoryPoint3;
  characterAtPosition(positionType: unknown): StoryCharacterHandle | null;
  showingCharacterTargets(): string[];
  characterMotionIdentity(target: string): string | null;
  hasCharacterController(target: string): boolean;
  isCharacterShowing(target: string, expectedIdentity?: string): boolean;

  selectCharacterAssetIndex(target: string, assetIndex: number): void;
  placeCharacter(cmd: AdvCommand, positionType: number, duration?: number, noWait?: boolean): Promise<unknown>;
  removeCharacter(target: string, duration?: number): Promise<boolean>;
  fadeCharacter(target: string, alpha: number, duration?: number): Promise<void>;
  moveCharacter(
    positionType: number,
    offset: Partial<StoryPoint3>,
    duration?: number,
    easeValue?: unknown,
  ): Promise<void>;
  moveCharacterToWorld(
    target: string,
    destination: Partial<StoryPoint3>,
    positionType: number,
    duration?: number,
    easeValue?: unknown,
  ): Promise<void>;
  prepareCharacterAngle(
    target: string,
    angle: number,
    bodyAngle: number,
    duration?: number,
  ): (() => Promise<void>) | null;
  setCharacterAngle(target: string, angle: number, bodyAngle: number, duration?: number): Promise<void>;
  prepareLook(
    target: string,
    lookX: number,
    lookY: number,
    duration?: number,
    enabled?: boolean,
  ): (() => Promise<void>) | null;
  prepareLookTarget(
    target: string,
    positionType: number,
    duration?: number,
    enabled?: boolean,
    lookTargetName?: string,
  ): (() => Promise<void>) | null;
  setLook(target: string, lookX: number, lookY: number, duration?: number, enabled?: boolean): Promise<void>;
  setLookTarget(
    target: string,
    positionType: number,
    duration?: number,
    enabled?: boolean,
    lookTargetName?: string,
  ): Promise<void>;
  playMotionForTarget(target: string, motionName?: string, fadeIn?: number, expectedIdentity?: string): void;
  playExpressionForTarget(target: string, expressionName?: string, fadeIn?: number, expectedIdentity?: string): void;
  /** Opcode 68: loop a parameter-fade motion until a stop request replaces it. */
  playParameterLoopForTarget(target: string, motionName: string, fadeIn?: number, expectedIdentity?: string): void;
  /** Opcode 68 "stop": end the target's parameter loop with its authored fade-out. */
  stopParameterLoopForTarget(target: string, fadeOut?: number, expectedIdentity?: string): void;
  /** Opcode 69: stop auto eye blink (lids ease open over `transitionSeconds`) or resume it. */
  setEyeBlinkStoppedForTarget(
    target: string,
    stopped: boolean,
    transitionSeconds?: number,
    expectedIdentity?: string,
  ): void;
  setCharacterPaused(target: string, paused: boolean): void;
  setCharacterForward(positionType: number): void;
  setCharacterBack(positionType: number): void;
  sortCharacters(): void;
  setPlaybackSpeed(rate: number): void;

  setBackground(
    background: AdvBackgroundEntry | null | undefined,
    duration?: number,
    captureToken?: number | null,
    signal?: AbortSignal,
  ): Promise<boolean>;
  captureStage(signal?: AbortSignal): Promise<number | null>;
  fadeStageCapture(duration: number, owner: number, signal?: AbortSignal): Promise<boolean>;
  resetStageCapture(owner?: number): void;
  setStill(still: AdvStillEntry | null | undefined, alpha?: number, duration?: number): Promise<void>;
  runStillCommand(
    still: AdvStillEntry | null | undefined,
    alpha?: number,
    overlayAlpha?: number,
    animationIndex?: number,
    duration?: number,
  ): Promise<void>;
  fadeStill(alpha: number, duration?: number): Promise<void>;
  clearStill(duration?: number): Promise<void>;
  setFrameOverlay(frame: AdvFrameEntry, alpha?: number, key?: string): Promise<void>;
  setFrameOpacity(alpha: number, slide?: number, key?: string): void;
  clearFrameOverlay(key?: string): void;
  setCover(color: unknown, opacity: unknown): void;
  flashWhite(duration?: number): Promise<void>;
  runRuleTransition(
    rule: AdvRuleTransitionEntry | null | undefined,
    color: unknown,
    duration: number,
    reveal: boolean,
  ): Promise<void>;

  /**
   * Resolves once playback has started; a fade-in continues detached (the
   * native Clip command does not wait for its own fade). `startSeconds` seeks
   * the media before playing, e.g. when a seek lands inside a clip.
   */
  showVideo(
    video: AdvVideoEntry | string,
    fadeIn?: number,
    startSeconds?: number,
    playbackRate?: number,
    signal?: AbortSignal,
    alpha?: number,
  ): Promise<void>;
  /** Live clock of the shown video (read directly, not the per-frame state copy). */
  videoClock?(): { mediaTime: number; paused: boolean; ended: boolean; failed?: boolean } | undefined;
  /** Pause/resume the current element without replacing its media clock. */
  setVideoPaused?(paused: boolean): void;
  fadeVideo(alpha: number, duration?: number): Promise<void>;
  hideVideo(fadeOut?: number): Promise<void>;
  skipVideo(): boolean;
  /**
   * Raw media-only seek for renderer-owned Movie playback. Logical Clips must
   * be sought through AdvPlayer.seekTo()/the indexed story path so command
   * cursor, cumulative media targets, and subtitles are restored together.
   */
  seekVideoRatio(ratio: unknown): boolean;
  waitVideoEnded(signal?: AbortSignal): Promise<void>;

  setCommandPostEffect(profile: AdvPostEffectEntry | string | unknown, fade?: number): Promise<void>;
  clearCommandPostEffects(fade?: number): Promise<void>;
  playCommandEffect(
    asset: AdvEffectEntry | null,
    options?: {
      readonly key?: string;
      readonly targetName?: string;
      readonly positionType?: number;
      readonly [key: string]: unknown;
    },
  ): Promise<void>;
  isCommandEffectPlaying(key: string): boolean;
  stopCommandEffects(): void;
  applyStageEnv(index?: number): void;
  applyStageLight(index?: number): void;
  applyStagePostEffect(index?: number): void;
  changeStageParticleEffects(index?: number): void;

  setRendererCharacterBrightness(
    target: string,
    value: number,
    duration?: number,
    positionType?: number,
  ): Promise<void>;
  setBrightness(target: string, value: number, duration?: number): Promise<void>;
  setPositionBrightness(positionType: number, value: number, duration?: number): Promise<void>;
  setBackgroundBrightness(value: number, duration?: number): Promise<void>;
  setBackgroundDoF(intensity: number, duration?: number, ease?: unknown, signal?: AbortSignal): Promise<void>;
  setCharacterDoF(
    target: string,
    intensity: number,
    duration?: number,
    ease?: unknown,
    signal?: AbortSignal,
  ): Promise<void>;
  cancelPendingCharacterDoF(target: string): void;
  setRimLight(target: string, color: unknown, shadowIntensity: number): Promise<void>;

  currentFocusData(distance: number): AdvFocusDataRow | null;
  closestFocusDataByZoomRatio(ratio: number): AdvFocusDataRow | null;
  focusBaseCameraPosition(positionType: number, targetName?: string, focusData?: AdvFocusDataRow | null): StoryPoint3;
  focus(options: Readonly<Record<string, unknown>>): Promise<void>;
  zoomByRatio(
    ratio: number,
    duration?: number,
    ease?: unknown,
    backgroundBlurOffset?: number | null,
    adjustBackgroundBlur?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  setCharacterStagesY(y: number, duration?: number, ease?: unknown, signal?: AbortSignal): Promise<void>;
  setTilt(angle: number, duration?: number, ease?: unknown, signal?: AbortSignal): Promise<void>;
  setCameraRoll(angle: number, duration?: number, ease?: unknown, signal?: AbortSignal): Promise<void>;
  panFocusDistance(focusPosition: { z?: number }): number;
  panV2CameraOffset(rotationY: number, distance: number, focusSlideRate: number): StoryPoint2;
  setPanV2CameraOffset(
    offset: Partial<StoryPoint2>,
    duration?: number,
    ease?: unknown,
    signal?: AbortSignal,
  ): Promise<void>;
  setPanV2BaseCameraPosition(
    position: Partial<StoryPoint3>,
    duration?: number,
    ease?: unknown,
    signal?: AbortSignal,
  ): Promise<void>;
  panV2(options: Readonly<Record<string, unknown>>): Promise<void>;

  shakeCommand(...args: unknown[]): Promise<void>;
  isCameraShakePlaying(): boolean;
  enableCameraShake(...args: unknown[]): Promise<void>;
  disableCameraShake(fadeDuration: number): Promise<void>;

  startTimedPseudoLipSync(targets: string[] | string, talkLength: number, speed?: number, multiplier?: number): void;
  startTimedHoldOpenPseudoLipSync(
    targets: string[] | string,
    opening: number,
    talkLength: number,
    speed?: number,
  ): void;
  startTimedPseudoLipSyncSeconds(
    targets: string[] | string,
    seconds: number,
    speed?: number,
    multiplier?: number,
  ): void;
  startVoiceLipSync(
    targets: string[] | string,
    sources: readonly VegaVoiceAnalysisSource[],
    seconds: number,
    speed?: number,
    multiplier?: number,
  ): boolean;
  stopTimedPseudoLipSync(targets: string[] | string): void;
  stopAllTimedPseudoLipSync(): void;
  stopSpeaking(targets: string[] | string): void;
  stopAllSpeaking(): void;
}

export type StorySceneBackendFactory = (
  context: StorySceneBackendContext,
) => StorySceneBackend | Promise<StorySceneBackend>;

export type StoryResourceBackend = Pick<
  StorySceneBackend,
  | "prepareStoryResources"
  | "enumerateStoryResources"
  | "loadTexture"
  | "preloadTexture"
  | "reservePreloadedTextures"
  | "preloadVideo"
  | "preloadCharacter"
  | "advanceCharacterPreload"
>;
