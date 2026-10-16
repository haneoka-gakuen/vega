export {
  AUTO_PLAY_INTERVAL_SECONDS,
  DEFAULT_AUTO_PLAY_INTERVAL,
  advAutoPlayReadDelaySeconds,
  autoPlayIntervalSeconds,
  normalizeAutoPlayInterval,
} from "./core/AdvAutoPlayInterval";
export type { AdvAutoPlayInterval } from "./core/AdvAutoPlayInterval";
export {
  chatDataRootForChatId,
  chatDataRootForWindowAsset,
  chatDefaultDataRoot,
  chatIconImagePath,
  chatWindowSpriteRectForDataRoot,
  isAdvChatIconAssetName,
  isGroupChatParticipants,
  resolveAdvChatMaster,
} from "./core/AdvChatAssets";
export type { AdvChatMaster, AdvChatRuntimeAssets, AdvChatWindowSpriteRect } from "./core/AdvChatAssets";
export {
  ADV_CHAT_WINDOW_TRANSITION,
  advChatWindowTransitionSeconds,
  evaluateAdvChatOutCubic,
  evaluateAdvChatOutExpo,
} from "./core/AdvChatTransition";
export type { AdvChatWindowTransitionKind } from "./core/AdvChatTransition";

export { AdvCommandService } from "./core/AdvCommandService";
export { VegaEngine, createVega, createVegaPlayerState } from "./engine/VegaEngine";
export {
  loadDenebRuntimePlugins,
  type DenebExternalRuntimeAccess,
  type DenebExternalRuntimeBinding,
  type DenebExternalRuntimeFile,
  type DenebRuntimePluginFactoryContext,
  type DenebRuntimePluginLoadOptions,
  type DenebRuntimePluginModule,
  type LoadedDenebRuntimePlugins,
} from "./engine/denebPlugins";
export type {
  VegaEngineStorage,
  VegaEngineOptions,
  VegaInputHandler,
  VegaPlayerHandle,
  VegaPlayerHost,
  VegaHostedPlayer,
  VegaPlayerOptions,
} from "./engine/VegaEngine";
export type { VegaPlayerService, VegaPlayerShellOptions } from "./engine/VegaEngine";
export { VegaLifetime } from "./engine/lifecycle";
export * from "./engine/plugins";
export * from "./marketplace";
export { advCommandGroupCommands, resolveAdvCommandGroup, sortAdvCommandGroupActions } from "./core/AdvCommandGroup";
export {
  advTextRenderSource,
  createAdvTextRenderValue,
  DEFAULT_ADV_TEXT_METRICS,
  VEGA_TEXT_METRICS,
} from "./core/AdvTextRenderValue";
export type { AdvTextMetrics, AdvTextRenderMetadata, AdvTextRenderValue } from "./core/AdvTextRenderValue";
export { AdvCommandGroupScheduler } from "./core/AdvCommandGroupScheduler";
export type { AdvCommandGroupSchedulerOptions } from "./core/AdvCommandGroupScheduler";
export { hasSemanticAdvText, splitAdvTargetNames } from "./core/AdvCommandText";
export { flattenAdvCommands, iterateAdvCommands } from "./core/AdvCommandTraversal";
export { AdvPlaybackSession } from "./core/AdvPlaybackSession";
export { AdvPlayerModel } from "./core/AdvPlayerModel";
export { AdvPlayableDirector, sortAdvTimelineSignals } from "./core/AdvPlayableDirector";
export type { AdvPlayableDirectorOptions, AdvTimelineClock } from "./core/AdvPlayableDirector";
export {
  AdvQualityConfig,
  DETERMINISTIC_BROWSER_BASE_QUALITY_MODE,
  isUnityLightingEnabledFor,
  normalizeBaseQualityMode,
} from "./core/AdvQualityConfig";
export { AdvBaseQualityMode, DETERMINISTIC_BROWSER_TARGET_FRAME_RATE } from "./types/AdvQuality";
export type {
  RendererAwareStoryCharacterProvider,
  StoryCharacterAnimationResourceUsage,
  StoryCharacterModel,
  StoryCharacterModelContext,
  StoryCharacterPresentation,
  StoryCharacterProvider,
  StoryCharacterResource,
  StoryCharacterResourceEnumerationContext,
  StoryCharacterResourceKind,
  StoryCharacterResourceRole,
  StoryCharacterRendererModel,
  StoryCharacterRendererModelContext,
} from "./rendering/StoryCharacterModel";
export {
  createRendererCharacterModel,
  disposeRendererCharacterModel,
  enumerateCharacterProviderResources,
  isRendererAwareCharacterProvider,
} from "./rendering/StoryCharacterModel";
export type {
  StoryCameraState,
  StoryCharacterHandle,
  StoryPoint2,
  StoryPoint3,
  StoryResourceLease,
  StoryResourceResolver,
  StorySceneBackend,
  StorySceneBackendContext,
  StorySceneBackendFactory,
  StoryScenePreviewOptions,
} from "./rendering/StorySceneBackend";
export type {
  StoryRendererEffectContribution,
  StoryRendererExtensionContext,
  StoryRendererExtensionRegistry,
  StoryRendererServiceKey,
} from "./rendering/StoryRendererExtensions";
export type {
  StoryResourceAdapter,
  StoryResourceCacheOptions,
  StoryResourceHttpOptions,
} from "./resources/StoryResourceResolver";
export type * from "./resources/StoryResourcePreparation";
export {
  configureStoryRuntime,
  isCanonicalStoryResourceUrl,
  requireCanonicalStoryResourceUrl,
  requireScopedStoryResourceUrl,
  resolveStoryLocalizedText,
  resetStoryRuntimeConfiguration,
  storyRuntime,
} from "./runtime";

export type {
  StoryChatIconSprites,
  StoryMessageKey,
  StoryResourceScope,
  StoryResolvedText,
  StoryRuntimeAdapters,
} from "./runtime";
export type { AdvQualityOverrides } from "./types/AdvQuality";
export {
  estimateVegaVisemeFrame,
  type AdvVoiceAnalyzer,
  type AdvVoicePcmSnapshot,
  type AdvVoiceSpectrumSample,
  type VegaViseme,
  type VegaVisemeFrame,
  type VegaVoiceAnalysisSource,
  type VegaVoiceAnalyzer,
  type VegaVoicePcmFrame,
  type VegaVoiceSpectrumFrame,
} from "./sound/VoiceAnalysis";
export type * from "./types/AdvRuntime";

export type { VegaExecutionDriver, VegaExecutionRecord } from "./execution/ports";
