export * from "./engine-entry";
export { createVegaWebUiActions } from "./web-ui-entry";
export type {
  VegaWebUiSlotContext,
  VegaWebUiSlotContribution,
  VegaUiSlotContext,
  VegaUiSlotContribution,
} from "./web-ui-entry";
export { VegaWebEngine as VegaEngine, createVegaWeb as createVega } from "./hosts/web/engine";
export type {
  VegaWebPlayerHandle as VegaPlayerHandle,
  VegaWebPlayerOptions as VegaPlayerOptions,
} from "./hosts/web/engine";
export { createVegaWebPlayerHost } from "./hosts/web/playerHost";
export {
  createBrowserNarrativeInput,
  narrativeInputValue,
  type VegaBrowserNarrativeInput,
} from "./hosts/web/browserNarrativeInput";
export { VegaLocalStorageSaveStorage } from "./hosts/web/saveStorage";
export { GenericStoryScene, type GenericStorySceneOptions } from "./rendering/dom/GenericStoryScene";
export {
  StaticPortraitModel,
  type StaticPortraitModelOptions,
  type StaticPortraitPivot,
} from "./rendering/portrait/StaticPortraitModel";
export { AdvPlayer } from "./core/AdvPlayer";
export {
  resolveVegaOfficialPlayerPlugins,
  selectVegaRenderContribution,
  type ResolveVegaOfficialPlayerPluginsOptions,
  type VegaOfficialPlayerPluginPreset,
  type VegaPlayerCommandExtensionRegistration,
} from "./engine/playerPluginPreset";
export * from "./resources/StoryResourcePreparation";

export { createRustVegaExecutionDriver } from "./execution/wasm";
