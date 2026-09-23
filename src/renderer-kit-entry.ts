/**
 * Stable, renderer-facing Vega primitives.
 *
 * This entry contains no Haneoka, Cubism, Spine, or extracted-asset
 * dependency. It defines only renderer-neutral contracts and algorithms;
 * graphics-framework implementations belong to renderer plugins.
 */
export { AdvCamera } from "./rendering/AdvCamera";
export {
  registerCharacterItem,
  UNITY_CHARACTER_FADE_DELAY_FRAMES,
  UnityCharacterFadeCoordinator,
  unityCharacterFadeDuration,
  type UnityCharacterFadeOptions,
} from "./rendering/AdvCharacterLifecycle";
export { AdaptiveRenderQuality, type AdaptiveRenderQualityOptions } from "./rendering/AdaptiveRenderQuality";
export {
  createRendererCharacterModel,
  disposeRendererCharacterModel,
  enumerateCharacterProviderResources,
  isRendererAwareCharacterProvider,
  type RendererAwareStoryCharacterProvider,
  type StoryCharacterAnimationResourceUsage,
  type StoryCharacterModel,
  type StoryCharacterModelContext,
  type StoryCharacterPresentation,
  type StoryCharacterProvider,
  type StoryCharacterResource,
  type StoryCharacterResourceEnumerationContext,
  type StoryCharacterResourceKind,
  type StoryCharacterResourceRole,
  type StoryCharacterRendererModel,
  type StoryCharacterRendererModelContext,
} from "./rendering/StoryCharacterModel";
export type * from "./rendering/StoryRendererExtensions";
export * from "./rendering/StoryScreenFilters";
export type * from "./rendering/StorySceneBackend";
export {
  DefaultStoryResourceResolver,
  storyResourceContentType,
  type StoryResourceAdapter,
} from "./resources/StoryResourceResolver";
export * from "./resources/StoryResourcePreparation";

export { AdvQualityConfig } from "./core/AdvQualityConfig";
export * from "./types/AdvQuality";
export * from "./types/AdvRuntime";
export * from "./core/AdvConstants";
export * from "./core/easing";
export * from "./core/AdvDoF";
export * from "./core/AdvSettlingWait";
export {
  AdvPlayableDirector,
  sortAdvTimelineSignals,
  type AdvPlayableDirectorOptions,
  type AdvTimelineClock,
} from "./core/AdvPlayableDirector";
export { VegaLifetime, type VegaDisposable } from "./engine/lifecycle";
export { flattenAdvCommands, iterateAdvCommands } from "./core/AdvCommandTraversal";
export {
  resolveVegaOfficialPlayerPlugins,
  selectVegaRenderContribution,
  type ResolveVegaOfficialPlayerPluginsOptions,
  type VegaOfficialPlayerPluginPreset,
  type VegaPlayerCommandExtensionRegistration,
} from "./engine/playerPluginPreset";

export * from "./rendering/neutral/AdvDotweenShake";
export * from "./rendering/neutral/AdvFrameLayout";
export * from "./rendering/neutral/StorySceneSnapshot";

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

export * from "./rendering/StoryScreenEffects";
export * from "./rendering/StoryFrameLayout";
export * from "./rendering/StoryStillPresentation";
export * from "./rendering/StoryPlaneLayout";

export * from "@haneoka/vega-protocol/coordinates";
