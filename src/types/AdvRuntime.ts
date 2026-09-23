import type { AdvBaseQualityMode, AdvQualityNumberTable, AdvQualityOverrides } from "./AdvQuality";
import type { AdvChatRuntimeAssets } from "../core/AdvChatAssets";
import type { VegaJsonValue } from "@haneoka/vega-protocol";

/**
 * Typed interfaces for the ADV story runtime.
 *
 * These capture only the fields ACTUALLY ACCESSED by the core engine. Fields whose
 * shape is genuinely opaque (deep game-runtime internals) are left `unknown`.
 */

/** Exact build-specific UI sprite URLs supplied by the story-runtime catalog. */
export interface StoryUiSprites {
  tapNext: string;
  tapNextGlow: string;
  next: string;
  psychEdge: string;
  psychLine: string;
  choice: string;
  choiceActive: string;
}

/** A point in the ADV scene's authored world basis (+Z points forward). */
export interface AdvWorldPosition {
  x: number;
  y: number;
  z: number;
}

/**
 * Optional absolute-world motion attached to a character command.
 *
 * Adapters resolve their source coordinate systems before producing this
 * value. The renderer therefore never needs source-specific screen-space
 * rules: it only interpolates real scene points through the regular camera.
 */
export interface AdvCharacterWorldTransition {
  from?: AdvWorldPosition;
  to: AdvWorldPosition;
  /** Position retained by the hidden controller after an Out transition. */
  restore?: AdvWorldPosition;
}

/** Motion/expression authored as part of one character layout transition. */
export interface AdvCharacterPresentation {
  motionName?: string;
  expressionName?: string;
  fadeInSeconds?: number;
}

// ---------------------------------------------------------------------------
// Runtime configuration (merged from DEFAULT_ADV_RUNTIME + story.runtime)
// ---------------------------------------------------------------------------

/** A single row in the focus-data table (indexed by cameraDistance). */
export interface AdvFocusDataRow {
  cameraDistance: number;
  fieldZoomRatio: number;
  fieldZoomOffsetY: number;
  characterBlurIntensity: number;
  backgroundBlurIntensity: number;
  characterHeadFocusOffsetY: number;
}

export interface AdvStageConfig {
  screenReferenceWidth?: number;
  screenReferenceHeight?: number;
  minX: number;
  maxX: number;
  width: number;
  backgroundSize: { width: number; height: number };
  positions: Record<number, { x: number; y: number; z: number }>;
  focusAnchors: Record<number, { x: number; y: number; z: number }>;
  initialCameraPosition?: AdvWorldPosition;
  initialCameraRotation?: AdvWorldPosition;
  characterFieldPosition?: AdvWorldPosition;
  backgroundFieldPosition?: AdvWorldPosition;
  characterFieldScale?: number;
  backgroundFieldScale?: number;
  /** Fixed import density for legacy canvas-pixel model formats. */
  characterPixelsPerUnit?: number;
  /** Fixed world height of a legacy model's complete canvas at authored scale. */
  characterCanvasWorldHeight?: number;
  /** Camera-relative background sizing. Authored stages retain their exact size. */
  backgroundFit?: "authored" | "camera-width" | "cover" | "contain";
  backgroundOverscan?: number;
  fov?: number;
}

export interface AdvLayoutConfig {
  designViewportAspect: number;
  portraitTargetAspect: number;
  /** Omit for native ADV's wide-screen rule; set to lock a scene to one landscape aspect. */
  landscapeTargetAspect?: number;
}

export interface AdvCaptureRigConfig {
  renderTextureSize: number;
}

export interface AdvFieldRendererConfig {
  blurRadiusMaxByCameraDistance: number[];
  curvedLensIntensityRateByCameraDistance: number[];
}

export interface AdvAudioConfig {
  categoryVolumes: { Bgm: number; Se: number; Voice: number };
}

/** Browser-neutral subset of CSS FontFace descriptors. */
export interface StoryFontFaceDescriptor {
  readonly family: string;
  readonly style?: string;
  readonly weight?: string | number;
  readonly stretch?: string;
  readonly unicodeRange?: string;
  readonly featureSettings?: string;
  readonly variationSettings?: string;
  readonly display?: "auto" | "block" | "swap" | "fallback" | "optional";
  /** Optional CSS font format hint such as `woff2`. */
  readonly format?: string;
}

export interface StoryVideoLayout {
  readonly viewport?: readonly [x: number, y: number, width: number, height: number];
  readonly fit?: "cover" | "contain" | "stretch";
  readonly background?: string;
}

/** One font face that must be usable before the story's first frame. */
export interface AdvFontEntry extends StoryFontFaceDescriptor {
  readonly source: string;
}

export interface AdvRuntimeConfig {
  /** Deterministic browser selection; the reference runtime persists a device-scored mode. */
  baseQualityMode: AdvBaseQualityMode;
  allowUnityLighting: boolean;
  allowCharacterBlur: boolean;
  allowBackgroundBlur: boolean;
  allowStageParticleEffect: boolean;
  allowStagePostEffect: boolean;
  isCharacterDistributedUpdate: boolean;
  characterDistributedUpdateRate: number;
  quality?: AdvQualityOverrides;
  targetNameSplitKey: string;
  waitAfterVoiceTime: number;
  waitTalkTextUnitTime: number;
  minTalkDisplayTime: number;
  waitVideoLingeringTimeOnAutoPlay: number;
  waitSubtitlesLingeringTimeOnAutoPlay: number;
  waitCommandLingeringTimeOnAutoPlay: number;
  shakeFieldStrength: number;
  shakeUIStrength: number;
  cameraShakeStrength: number;
  cameraShakeDuration: number;
  cameraShakeVibrato: number;
  cameraShakeRandomness: number;
  defaultPanV2FocusSlideRate: number;
  focusEase: number;
  rendererResolutionScale: number;
  /** AdvPlayerSettings render-scale fields in Worst -> Best enum order. */
  renderScaleByQuality: AdvQualityNumberTable;
  rendererResolutionMax: number;
  rendererPixelCountMax: number;
  adaptiveRenderScaleEnabled: boolean;
  adaptiveRenderScaleMin: number;
  targetFrameRate: number;
  /** AdvPlayerSettings frame-rate fields in Worst -> Best enum order. */
  targetFrameRateByQuality: AdvQualityNumberTable;
  lowTargetFrameRate: number;
  /** Phase 1 (blocking boot) preload worker count. Served over HTTP/2, so 8 is safe. */
  preloadConcurrency: number;
  preloadAheadCommands: number;
  preloadBehindCommands: number;
  preloadBackgroundConcurrency: number;
  /** Distinct character controllers made render-ready before playback starts. */
  characterPreloadInitialCount: number;
  /** Rolling command window used for renderer-ready character preparation. */
  characterPreloadAheadCommands: number;
  /** GPU model construction concurrency; intentionally lower than URL fetch concurrency. */
  characterPreloadConcurrency: number;
  /** Maximum renderer-ready controllers retained before their first authored In. */
  characterPreloadCacheMax: number;
  /** Maximum number of proven command-boundary seek snapshots retained per story object. */
  seekCheckpointLimit?: number;
  textureCacheEntryMax: number;
  textureCacheMegabytes: number;
  compressedTextureVariants: Record<string, string>;
  characterBlurEnabled: boolean;
  backgroundBlurEnabled: boolean;
  /** Focus-data `_characterBlurEnabled`; independent from explicit DoF quality. */
  focusCharacterBlurEnabled: boolean;
  /** Focus-data `_backgroundBlurEnabled`; independent from explicit DoF quality. */
  focusBackgroundBlurEnabled: boolean;
  viewportFollowOnResolutionChanged: boolean;
  captureRig: AdvCaptureRigConfig;
  stage: AdvStageConfig;
  layout: AdvLayoutConfig;
  focusData: AdvFocusDataRow[];
  fieldRenderer: AdvFieldRendererConfig;
  audio: AdvAudioConfig;
  /** Fonts referenced by story text or the active presentation theme. */
  fonts?: readonly AdvFontEntry[];
  /** Build-derived MasterAdvChat rows and exact prefab/sprite geometry. */
  chatAssets?: AdvChatRuntimeAssets;
  /** Merged from story.stage at runtime; may carry extra dynamic fields. */
  backgroundSize?: { width: number; height: number };
  /** Accessed in AdvSceneRoot for physics toggle. */
  allowCharacterPhysics: boolean;
  allowCharacterBreathMotion: boolean;
  /** AdvPlayerSettings._defaultTransitionAssetAddress, resolved to its real settings asset. */
  defaultRuleTransition?: AdvRuleTransitionEntry;
  /** Focus data settings key override. */
  usingFocusDataSettingsKey?: string;
  postEffects?: Record<string, AdvPostEffectEntry>;
  stages?: Record<string, AdvStageEntry>;
  /**
   * Additional dynamic fields the runtime may carry but the engine does not
   * access directly. Typed `unknown` so callers must narrow.
   */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Story / episode data
// ---------------------------------------------------------------------------

export interface AdvSoundEntry {
  playableUrl?: string;
  /** Per-cue authored gain, multiplied with category and user volume. */
  volume?: number;
  durationMs?: number;
  durationSeconds?: number;
  durationSec?: number;
  totalSamples?: number;
  sampleRate?: number;
  cueName?: string;
  cueSheetName?: string;
  soundId?: number;
  id?: number;
  categoryName?: string;
  /** Additional fields. */
  [key: string]: unknown;
}

export interface AdvVoiceEntry extends AdvSoundEntry {
  /** Used as voice identifier for lip sync. */
  chatSound?: AdvSoundEntry;
}

export interface AdvVideoEntry {
  playableUrl?: string;
  src?: string;
  url?: string;
  /** Additional fields. */
  [key: string]: unknown;
}

export interface AdvCharacterAnimationEntry {
  name?: string;
  runtime?: string;
  [key: string]: unknown;
}

export interface AdvStaticPortraitPivot {
  /** Normalized distance from the image's left edge. */
  x?: number;
  /** Normalized distance from the image's bottom edge. */
  y?: number;
}

export interface AdvCharacterRuntimeEntry {
  format?: "static-portrait" | (string & {});
  /** Source-neutral provider descriptor or manifest URL. */
  model?: string;
  /** Compatibility alias for hosts that expose a resolved model URL. */
  modelUrl?: string;
  /** Resolved static character image URL. */
  imageUrl?: string;
  /** Canvas pixels per model-local world unit for provider-defined formats. */
  pixelsPerUnit?: number;
  /** Complete model canvas height in authored world units. */
  canvasWorldHeight?: number;
  /** Full static portrait image height in authored world units. */
  worldHeight?: number;
  /** Normalized lower-left-origin pivot for a static portrait image. */
  pivot?: AdvStaticPortraitPivot;
  /** Provider manifests may keep their animation catalog beside model resources. */
  motions?: AdvCharacterAnimationEntry[];
  expressions?: AdvCharacterAnimationEntry[];
  /**
   * Provider-owned payload. Vega deliberately does not type or interpret
   * format-specific resource fields here.
   */
  [key: string]: unknown;
}

export interface AdvCharacterModelEntry {
  runtime?: AdvCharacterRuntimeEntry;
  motions?: AdvCharacterAnimationEntry[];
  expressions?: AdvCharacterAnimationEntry[];
  /** Additional fields. */
  [key: string]: unknown;
}

const characterResourceRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const characterDescriptorString = (...values: unknown[]): string =>
  values.map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) ?? "";

const hasProviderPayloadValue = (
  value: unknown,
  ignoredKeys = new Set<string>(),
  seen = new WeakSet<object>(),
): boolean => {
  if (typeof value === "string") return Boolean(value.trim());
  if (value == null) return false;
  if (typeof value !== "object") return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => hasProviderPayloadValue(entry, new Set(), seen));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => !ignoredKeys.has(key) && hasProviderPayloadValue(entry, new Set(), seen),
  );
};

const RUNTIME_DESCRIPTOR_KEYS = new Set(["format", "model", "modelUrl", "imageUrl", "motions", "expressions"]);

const CHARACTER_DESCRIPTOR_KEYS = new Set([
  "runtime",
  "format",
  "model",
  "modelUrl",
  "imageUrl",
  "motions",
  "expressions",
  "profile",
]);

/**
 * True when an entry has a source-neutral descriptor or non-empty
 * provider-owned payload.
 *
 * Completeness and file-format validation belong to the selected character
 * provider. The ADV core never guesses a provider from proprietary fields or
 * filename suffixes.
 */
export const hasAdvCharacterModel = (entry: AdvCharacterModelEntry | null | undefined): boolean => {
  const source = characterResourceRecord(entry);
  const runtime = characterResourceRecord(source.runtime);
  if (characterDescriptorString(runtime.model, runtime.modelUrl, source.model, source.modelUrl)) return true;
  if (characterDescriptorString(runtime.imageUrl, source.imageUrl)) return true;
  return (
    hasProviderPayloadValue(runtime, RUNTIME_DESCRIPTOR_KEYS) ||
    hasProviderPayloadValue(source, CHARACTER_DESCRIPTOR_KEYS)
  );
};

/**
 * Some ADV catalog payloads put clips on the command while provider manifests
 * put them in their runtime descriptor. Read one normalized catalog so callers
 * do not need to know the source format.
 */
export const advCharacterMotions = (entry: AdvCharacterModelEntry | null | undefined): AdvCharacterAnimationEntry[] =>
  entry?.motions?.length ? entry.motions : entry?.runtime?.motions || [];

export const advCharacterExpressions = (
  entry: AdvCharacterModelEntry | null | undefined,
): AdvCharacterAnimationEntry[] => (entry?.expressions?.length ? entry.expressions : entry?.runtime?.expressions || []);

export interface AdvBackgroundEntry {
  url?: string;
  stageRef?: string;
  stage?: AdvStageEntry;
  /** Additional fields. */
  [key: string]: unknown;
}

export interface AdvStageEntry {
  assetName?: string;
  initialCameraPosition?: Partial<AdvWorldPosition>;
  initialCameraRotation?: Partial<AdvWorldPosition>;
  characterFieldPosition?: Partial<AdvWorldPosition>;
  backgroundFieldPosition?: Partial<AdvWorldPosition>;
  characterFieldScale?: number;
  backgroundFieldScale?: number;
  characterPixelsPerUnit?: number;
  characterCanvasWorldHeight?: number;
  backgroundFit?: "authored" | "camera-width" | "cover" | "contain";
  backgroundOverscan?: number;
  backgroundSize?: { width: number; height: number };
  fov?: number;
  environmentPostEffectRefs?: string[];
  environmentPostEffects?: AdvPostEffectEntry[];
  environmentLightGroups?: Array<Record<string, unknown>>;
  focusPointGroups?: unknown[][];
  [key: string]: unknown;
}

export interface AdvStillEntry {
  url?: string;
  /** Additional fields. */
  [key: string]: unknown;
}

export interface AdvFrameNumericRange {
  mode?: number;
  min?: number;
  max?: number;
  rawMinScalar?: number;
  rawScalar?: number;
  [key: string]: unknown;
}

export interface AdvFrameParticleLayer {
  name?: string;
  rate?: number;
  duration?: number;
  prewarm?: boolean;
  lifetime?: AdvFrameNumericRange;
  speed?: AdvFrameNumericRange;
  size?: AdvFrameNumericRange;
  sizeY?: AdvFrameNumericRange;
  rotation?: AdvFrameNumericRange;
  alpha?: AdvFrameNumericRange;
  maxParticles?: number;
  shape?: {
    type?: number;
    position?: { x?: number; y?: number; z?: number };
    scale?: { x?: number; y?: number; z?: number };
    [key: string]: unknown;
  };
  velocity?: {
    x?: AdvFrameNumericRange;
    y?: AdvFrameNumericRange;
    z?: AdvFrameNumericRange;
    [key: string]: unknown;
  };
  transform?: {
    position?: { x?: number; y?: number };
    scale?: { x?: number; y?: number; z?: number };
    rotation?: number;
    [key: string]: unknown;
  };
  renderer?: {
    renderMode?: number;
    lengthScale?: number;
    maxParticleSize?: number;
    materialPathId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AdvFrameEntry {
  texture?: string;
  textures?: Record<string, string>;
  edges?: Array<{ texture?: string; [key: string]: unknown }>;
  elements?: Array<{ texture?: string; [key: string]: unknown }>;
  color?: string;
  canvasAlpha?: number;
  bandHeight?: number;
  bandWidth?: number;
  referenceWidth?: number;
  referenceHeight?: number;
  slideDistance?: number;
  type?: string;
  clips?: Record<string, number>;
  variant?: string;
  direction?: string;
  rate?: number;
  layers?: AdvFrameParticleLayer[];
  rootTransform?: {
    position?: { x?: number; y?: number };
    rotation?: number;
    [key: string]: unknown;
  };
  name?: string;
  source?: string;
  /** Additional fields. */
  [key: string]: unknown;
}

export interface AdvEffectEntry {
  textures?: Record<string, string>;
  name?: string;
  source?: string;
  /** Renderer-plugin-owned effect definition. */
  runtime?: Readonly<Record<string, unknown>> | null;
  /** Additional fields. */
  [key: string]: unknown;
}

/** UnityEngine.Keyframe serialized by RuleTransitionSettings._easingCurve. */
export interface UnityAnimationCurveKeyframe {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
  weightedMode: number;
  inWeight: number;
  outWeight: number;
}

/** UnityEngine.AnimationCurve, including the serialized infinity modes. */
export interface UnityAnimationCurve {
  keys: UnityAnimationCurveKeyframe[];
  preInfinity: number;
  postInfinity: number;
  rotationOrder: number;
}

export interface AdvRuleTransitionEntry {
  texture?: string;
  maskTexture?: string;
  gradient?: boolean;
  easingCurve?: UnityAnimationCurve;
  name?: string;
  source?: string;
  textureSize?: { width: number; height: number };
  /** Additional fields. */
  [key: string]: unknown;
}

export interface AdvPostEffectEntry {
  name?: string;
  componentOrder?: string[];
  components?: Record<string, Record<string, unknown>>;
  curvedLens?: Record<string, unknown>;
  /** Additional fields. */
  [key: string]: unknown;
}

/** A SignalEmitter and its AdvEpisodeSignal payload. */
export interface AdvTimelineSignal {
  /** SignalEmitter.m_Time, in Timeline seconds. */
  time: number;
  /** AdvEpisodeSignal.Episode normalized through the regular command schema. */
  episode: AdvCommand;
  retroactive?: boolean;
  emitOnce?: boolean;
  sourceTrackName?: string;
  sourceTrackIndex?: number;
  sourceMarkerIndex?: number;
}

/** Serialized AdvTimeline/TimelineAsset data needed by the browser director. */
export interface AdvTimeline {
  assetName: string;
  /** Native Addressables address: `Adv/Timeline/${assetName}`. */
  assetAddress: string;
  /** TimelineAsset duration in seconds. */
  duration: number;
  durationMode?: number;
  fixedDuration?: number;
  frameRate?: number;
  signals: AdvTimelineSignal[];
  source?: string;
  recovery?: {
    outputTrackCount: number;
    markerCount: number;
    unresolvedSignalCount: number;
  };
}

export interface AdvTargetEntry {
  target?: string;
  name?: unknown;
  /** Additional fields. */
  [key: string]: unknown;
}

/** Source-neutral dialogue reveal timing for hosts that reproduce an authored player. */
export interface AdvTalkTextReveal {
  /** JavaScript UTF-16 units preserve players that advance text with String#slice. */
  unit?: "code-point" | "utf16-code-unit";
  unitsPerSecond?: number;
  /** Whether the first unit appears after one interval instead of immediately. */
  delayFirstUnit?: boolean;
}

/** Optional Talk interaction semantics supplied by an import adapter. */
export interface AdvTalkPresentation {
  appendText?: boolean;
  retainSpeaker?: boolean;
  fontScale?: number;
  textReveal?: AdvTalkTextReveal;
  /** Auto-play waits from completed reveal instead of adding a second reading delay. */
  autoAdvanceAfterTextReveal?: boolean;
  /** Keep the authored reveal clock for auto-play even when text is displayed instantly. */
  preserveAutoAdvanceTimingWhenInstant?: boolean;
  /** Drive a timed mouth when the source dialogue has no playable voice. */
  timedLipSyncWhenVoiceUnavailable?: boolean;
  /** Stop only this Talk command's voice instances when a user advances it. */
  stopVoicesOnManualAdvance?: boolean;
  /** Whether a new Talk replaces existing voice instances or may overlap them. */
  voicePlayback?: "replace" | "overlap";
}

/** One authored entry in the choice group loaded by a ChoiceShow command. */
export interface AdvChoiceDefinition {
  choiceValue: number;
  text: unknown;
  textId?: string;
  nextKey: string;
  /** Optional portable/WebGAL visibility condition evaluated when ChoiceShow opens. */
  visibleWhen?: string;
  /** Optional portable/WebGAL availability condition evaluated when ChoiceShow opens. */
  enabledWhen?: string;
}

/** Source-game choice notification payload. */
export interface AdvChoiceRecord {
  advId: number;
  choiceIndex: number;
  choiceValue: number;
}

export interface AdvCommandGroupAction {
  atSeconds: number;
  role: "lifetime" | "event";
  command: AdvCommand;
}

/** Generic concurrent Story command object. */
export interface AdvCommandGroup {
  waitForPrevious: boolean;
  cancelOnManualAdvance: boolean;
  durationSeconds: number;
  actions: AdvCommandGroupAction[];
}

/** A single ADV command from the episode script. */
export interface AdvCommand {
  commandId?: string;
  commandType?: string;
  command?: unknown;
  index?: number;
  advId?: number;
  key?: string;
  name?: string;
  params?: string[];
  targets?: AdvTargetEntry[];
  targetName?: string;
  targetAssetName?: string;
  targetAssetIndex?: number;
  targetStatus?: number;
  targetTextIds?: unknown;
  targetTextIDs?: unknown;
  TargetTextIDs?: unknown;
  TargetTextIds?: unknown;
  targetTextNames?: unknown;
  targetTextNamesLocalized?: unknown;
  targetTextColors?: unknown;
  positionType?: number;
  /** Absolute authored world position for a target-bound character. */
  characterWorldPosition?: AdvWorldPosition;
  /** Absolute authored world transition for a target-bound character. */
  characterWorldTransition?: AdvCharacterWorldTransition;
  /** Presentation applied before this character transition starts. */
  characterPresentation?: AdvCharacterPresentation;
  /** Provider-authored cross-character draw order; larger values render first (behind). */
  characterRenderOrder?: number;
  cameraDistance?: number;
  advTextId?: string;
  text?: string;
  /** Flattened localized text sources retained by a composed dialogue. */
  textSegments?: unknown[];
  /**
   * Optional rich-text format owned by a renderer plugin.
   *
   * Omission preserves the legacy ADV grammar; Vega never infers a format
   * from text contents.
   */
  textFormat?: string | undefined;
  /** Optional block-style rendering hint for rich-text plugins. */
  textDisplayMode?: boolean | undefined;
  commandGroup?: AdvCommandGroup | null;
  duration?: number;
  delaySeconds?: number;
  noWait?: boolean;
  ignoreLipSync?: unknown;
  /** Voice-index-aligned mouth targets when they differ from the dialogue speaker. */
  lipSyncTargets?: string[];
  talkPresentation?: AdvTalkPresentation;
  /** Hide the dialogue surface after this Talk command completes. */
  hideTalkOnComplete?: boolean;
  ignoreData?: boolean;
  /** Native loader-only field retained for exact Episode preload semantics. */
  hiddenParameter1?: string;
  raw?: Record<string, unknown>;
  background?: AdvBackgroundEntry;
  still?: AdvStillEntry;
  frame?: AdvFrameEntry;
  frameName?: string;
  bgm?: AdvSoundEntry;
  se?: AdvSoundEntry | null;
  seId?: unknown;
  chatSound?: AdvSoundEntry;
  voices?: AdvVoiceEntry[];
  voiceIds?: unknown;
  bgmId?: unknown;
  videoId?: unknown;
  video?: AdvVideoEntry;
  movie?: AdvVideoEntry;
  clip?: AdvVideoEntry;
  characterModel?: AdvCharacterModelEntry;
  characterKey?: string;
  motionName?: string;
  motionFadeIn?: number;
  motionWait?: number;
  expressionName?: string;
  canvasLayers?: number[];
  ruleTransition?: AdvRuleTransitionEntry;
  effect?: AdvEffectEntry;
  postEffect?: AdvPostEffectEntry;
  postEffectRef?: string;
  timeline?: AdvTimeline | null;
  dofActive?: boolean;
  talkWindow?: string;
  targetChatID?: number;
  chatPresetRef?: string;
  chatWindowAssetName?: string;
  chatIconAssetName?: string;
  chatMemoryId?: string;
  /** Choice group returned for this command's first integer parameter. */
  choices?: AdvChoiceDefinition[];
  /**
   * Additional fields commands may carry. Typed `unknown` so access sites must
   * narrow.
   */
  [key: string]: unknown;
}

export interface AdvStory {
  commands?: AdvCommand[];
  runtime?: Partial<AdvRuntimeConfig>;
  localization?: {
    locales?: readonly string[];
    defaultLocale?: string;
    arrayOrder?: readonly string[];
  };
  /** Additional fields. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Player state (reactive, consumed by both core and Vue components)
// ---------------------------------------------------------------------------

export interface AdvFrameState {
  frame: AdvFrameEntry | null;
  opacity: number;
  slide: number;
  [key: string]: unknown;
}

export interface AdvChatMessage {
  sourceCommand?: AdvCommand;
  id: string;
  speaker: string;
  speakerLang?: string;
  text?: string;
  textLang?: string;
  stamp?: string;
  self?: boolean;
  readCount?: number;
  icon?: string;
  iconAssetName?: string;
  iconChatId?: number;
  read?: boolean;
  [key: string]: unknown;
}

export interface AdvChoiceItem {
  sourceText?: unknown;
  key: string;
  text: string;
  lang?: string;
  textId?: string;
  nextKey: string;
  /** Absent preserves native choice behavior; false renders the item disabled. */
  enabled?: boolean;
  record: AdvChoiceRecord;
}

/** Reactive player state (created by Vue's createState, consumed by core commands). */
export interface AdvPlayerState {
  loading: boolean;
  ready: boolean;
  playing: boolean;
  finished: boolean;
  seeking: boolean;
  paused: boolean;
  autoPlay: boolean;
  fastForward: boolean;
  instantText: boolean;
  error: string;
  commandIndex: number;
  commandCount: number;
  currentCommand: AdvCommand | null;
  viewport: {
    x: number;
    y: number;
    width: number;
    height: number;
    surfaceWidth: number;
    surfaceHeight: number;
  };
  session: unknown;
  pluginState: Record<string, VegaJsonValue>;
  stage: unknown;
  background: unknown;
  still: unknown;
  frame: AdvFrameEntry | null;
  frameName: string;
  frameOpacity: number;
  frameSlide: number;
  frameEntries: Record<string, AdvFrameState>;
  stageEnv: {
    all: number;
    light: number;
    effect: number;
    postEffect: number;
    focusPosition: number;
  };
  postEffect: unknown;
  dofActive: boolean;
  effect: unknown;
  cover: { color: string; opacity: number };
  talk: {
    sourceCommand?: AdvCommand;
    presentation?: string;
    instantReveal?: boolean;
    prefixLength?: number;
    fontScale?: number;
    enabled: boolean;
    visible: boolean;
    speaker: string;
    speakerLang?: string;
    text: string;
    textLang?: string;
    displayedText: string;
    /** Renderer format copied from the active Talk command. */
    textFormat?: string | undefined;
    /** Block-style rendering hint copied from the active Talk command. */
    textDisplayMode?: boolean | undefined;
    textComplete: boolean;
    targetName: string;
    window: string;
    shakeX: number;
    shakeY: number;
  };
  talkLog: AdvTalkLogEntry[];
  title: { sourceText?: unknown; visible: boolean; text: string; lang?: string; duration: number };
  location: { sourceText?: unknown; visible: boolean; text: string; lang?: string };
  subtitles: {
    sourceText?: unknown;
    visible: boolean;
    text: string;
    lang?: string;
    /** Last authored subtitle retained while subtitle display is disabled. */
    lastText: string;
    lastLang?: string;
  };
  chat: {
    sourceCommand?: AdvCommand;
    typingSource?: unknown;
    visible: boolean;
    title: string;
    titleLang?: string;
    messages: AdvChatMessage[];
    typing: string;
    typingLang?: string;
    readVisible: boolean;
    screenMode: number;
    battery: number;
    batteryText: string;
    chatId: number;
    participants: string;
    windowKey: string;
    memoryId: string;
    windowAssetName: string;
    dataRoot: string;
    iconAssetName: string;
    group: boolean;
  };
  choices: { visible: boolean; items: AdvChoiceItem[] };
  video: {
    layout?: StoryVideoLayout;
    visible: boolean;
    src: string;
    alpha: number;
    playbackRate: number;
    playing: boolean;
    ended: boolean;
    currentTime: number;
    duration: number;
    progress: number;
    /** Additional dynamic fields set at runtime. */
    [key: string]: unknown;
  };
  audio: { bgm: string; se: string; voice: string };
  preload: { done: number; total: number; label: string; failures: string[] };
  unknownCommands: Array<{ index: number; command: unknown; name: string }>;
  unsupported: Array<{ index: number; command: unknown; name: string }>;
  /** Dynamic properties set at runtime. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Playback session — sub-types
// ---------------------------------------------------------------------------

export interface AdvTalkLogEntry {
  sourceCommand?: AdvCommand;
  speaker: string;
  speakerLang?: string;
  text: string;
  textLang?: string;
  textFormat?: string | undefined;
  textDisplayMode?: boolean | undefined;
  commandIndex?: number;
  [key: string]: unknown;
}

export interface AdvChatMemoryEntry {
  sourceCommand?: AdvCommand;
  entryType: number;
  senderChatId: number;
  senderName: string;
  senderLang?: string;
  text: string;
  textLang?: string;
  stampAssetName: string;
  readCount: number;
  self?: boolean;
  icon?: string;
  iconAssetName?: string;
  [key: string]: unknown;
}

export interface AdvChatMemoryState {
  entries: AdvChatMemoryEntry[];
  senderReadStateMap: Map<number, { currentReadCount: number; lastReadAppliedEntryCount: number }>;
}

/** Flow parameters for clip video playback. */
export interface AdvFlowParameters {
  isClipVideoPlaying: boolean;
  isClipVideoSkip: boolean;
  setClipVideoPlaying(v: boolean): void;
  setClipSkip(v: boolean): void;
}

/** Character variant info stored in the loader. */
export interface AdvCharacterVariant {
  characterModel: AdvCharacterModelEntry;
  characterKey?: string;
  targetAssetIndex: number;
  [key: string]: unknown;
}
