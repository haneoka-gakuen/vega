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
  VegaCommandRegistration,
  VegaEngineOptions,
  VegaEnginePhase,
  VegaEngineStorage,
  VegaInputHandler,
  VegaPlayerHandle,
  VegaPlayerHost,
  VegaHostedPlayer,
  VegaPlayerOptions,
  VegaPlayerService,
  VegaPlayerShellOptions,
} from "./engine/VegaEngine";
export type { AdvPlayerState, AdvStory } from "./types/AdvRuntime";
export {
  estimateVegaVisemeFrame,
  type VegaViseme,
  type VegaVisemeFrame,
  type VegaVoiceAnalysisSource,
  type VegaVoiceAnalyzer,
  type VegaVoicePcmFrame,
  type VegaVoiceSpectrumFrame,
} from "./sound/VoiceAnalysis";
export { VegaEventBus } from "./engine/events";
export type { VegaDiagnosticEvent, VegaEventMap } from "./engine/events";
export { VegaLifetime } from "./engine/lifecycle";
export type { VegaDisposable } from "./engine/lifecycle";
export * from "./engine/plugins";
export * from "./marketplace";
export type * from "./resources/StoryResourcePreparation";
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
export { vegaProjectToAdvStory } from "./engine/projectRuntime";

export type { VegaExecutionDriver, VegaCheckpointExecutionDriver, VegaExecutionOwnershipDriver, VegaExecutionRecord } from "./execution/ports";
