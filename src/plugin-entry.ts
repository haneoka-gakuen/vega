export { VegaEventBus } from "./engine/events";
export type { VegaDiagnosticEvent, VegaEventMap } from "./engine/events";
export { VegaLifetime } from "./engine/lifecycle";
export type { VegaDisposable } from "./engine/lifecycle";
export * from "./engine/plugins";
export * from "./marketplace";
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
export type {
  AdvChatMaster,
  AdvChatRuntimeAssets,
  AdvChatWindowSpriteRect,
} from "./core/AdvChatAssets";
export {
  ADV_CHAT_WINDOW_TRANSITION,
  advChatWindowTransitionSeconds,
  evaluateAdvChatOutCubic,
  evaluateAdvChatOutExpo,
} from "./core/AdvChatTransition";
export type { AdvChatWindowTransitionKind } from "./core/AdvChatTransition";
export {
  advTextSizePercent,
  parseAdvRichText,
} from "./core/AdvRichText";
export type {
  AdvRichTextBreakNode,
  AdvRichTextNode,
  AdvRichTextRubyNode,
  AdvRichTextSizeNode,
  AdvRichTextTextNode,
} from "./core/AdvRichText";
export {
  advTextRenderSource,
  createAdvTextRenderValue,
} from "./core/AdvTextRenderValue";
export type {
  AdvTextRenderMetadata,
  AdvTextRenderValue,
} from "./core/AdvTextRenderValue";
export {
  estimateVegaVisemeFrame,
  type VegaViseme,
  type VegaVisemeFrame,
  type VegaVoiceAnalysisSource,
  type VegaVoiceAnalyzer,
  type VegaVoicePcmFrame,
  type VegaVoiceSpectrumFrame,
} from "./sound/VoiceAnalysis";
export {
  VEGA_STANDARD_UI_SLOTS,
  type VegaStandardUiSlot,
} from "./engine/playerPresentation";
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
  RendererAwareStoryCharacterProvider,
  StoryCharacterAnimationResourceUsage,
  StoryCharacterDescriptorPreparationContext,
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
  prepareCharacterProviderDescriptors,
} from "./rendering/StoryCharacterModel";
