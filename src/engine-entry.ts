export { VegaEngine, createVega, createVegaPlayerState } from "./engine/VegaEngine";
export {
  createBrowserNarrativeInput,
  narrativeInputValue,
  type VegaBrowserNarrativeInput,
} from "./engine/browserNarrativeInput";
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
export {
  resolveVegaOfficialPlayerPlugins,
  selectVegaRenderContribution,
} from "./engine/playerPluginPreset";
export type {
  ResolveVegaOfficialPlayerPluginsOptions,
  VegaOfficialPlayerPluginPreset,
} from "./engine/playerPluginPreset";
export * from "./engine/plugins";
export * from "./marketplace";
export { GenericStoryScene } from "./rendering/dom/GenericStoryScene";
export type { GenericStorySceneOptions } from "./rendering/dom/GenericStoryScene";
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
