import type { VegaDisposable } from "../engine/lifecycle";
import type { AdvPlayerState, AdvRuntimeConfig, AdvStory } from "../types/AdvRuntime";
import type { StoryResourceResolver } from "./StorySceneBackend";
import type { StoryResourceDeclaration } from "../resources/StoryResourcePreparation";

/**
 * Structural service key accepted by renderer extensions.
 *
 * `VegaServiceKey` extends this type, so renderers do not need to import the
 * plugin host in order to consume a host-provided service.
 */
export interface StoryRendererServiceKey<T> {
  readonly id: string;
  readonly __type?: T;
}

/**
 * Renderer-neutral context supplied when a scene backend instantiates an
 * effect contribution.
 */
export interface StoryRendererExtensionContext<
  TRendererId extends string = string,
  TRendererContext extends object = object,
> {
  readonly renderer: TRendererId;
  readonly rendererContext: TRendererContext;
  readonly runtime: AdvRuntimeConfig;
  readonly state: AdvPlayerState;
  readonly resources: StoryResourceResolver;
  readonly signal: AbortSignal;
  readonly service: <T>(key: StoryRendererServiceKey<T>) => T | undefined;
}

/** Renderer identity and services available before an extension is played. */
export interface StoryRendererResourcePreparationContext {
  readonly renderer: string;
  readonly story: AdvStory;
  readonly runtime: AdvRuntimeConfig;
  readonly state: AdvPlayerState;
  readonly resources: StoryResourceResolver;
  readonly signal: AbortSignal;
  readonly service: <T>(key: StoryRendererServiceKey<T>) => T | undefined;
}

/**
 * Effect factory visible to a scene backend.
 *
 * Definitions remain portable data. The renderer id and typed host context
 * let an implementation select WebGL, WebGPU, Three, Pixi, native, or another
 * rendering path without Vega importing it.
 */
export interface StoryRendererEffectContribution {
  readonly id: string;
  readonly name?: string;
  readonly effectType: string;
  /** One-time runtime preparation, invoked only when this story uses the effect. */
  prepareStoryResources?(context: StoryRendererResourcePreparationContext): void | Promise<void>;
  /**
   * Resolve manifests and return the leaf resources used by this definition.
   * Fields such as `urls`, `sources`, or manifest contents remain plugin-owned.
   */
  enumerateEffectResources?(
    definition: Readonly<Record<string, unknown>>,
    context: StoryRendererResourcePreparationContext,
  ): readonly StoryResourceDeclaration[] | Promise<readonly StoryResourceDeclaration[]>;
  create(
    definition: Readonly<Record<string, unknown>>,
    context: StoryRendererExtensionContext,
    signal: AbortSignal,
  ): VegaDisposable | Promise<VegaDisposable>;
}

/**
 * Immutable extension snapshot passed to a newly constructed scene backend.
 */
export interface StoryRendererExtensionRegistry {
  readonly effects: readonly StoryRendererEffectContribution[];
  service<T>(key: StoryRendererServiceKey<T>): T | undefined;
}
