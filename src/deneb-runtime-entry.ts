/**
 * Deneb's distributable adapter is intentionally presentation-neutral.
 * Generated applications assemble renderers, shells, themes, and UI only
 * through an explicit runtime plugin index or `engineOptions`.
 */
export {
  createDenebRuntime,
  DENEB_RUNTIME_ABI_VERSION,
  DENEB_RUNTIME_CAPABILITIES,
  vegaProjectToAdvStory,
} from "./engine/denebRuntime";
export type {
  DenebRuntime,
  DenebRuntimeFactoryOptions,
  DenebRuntimeMount,
  DenebRuntimeMountOptions,
} from "./engine/denebRuntime";
