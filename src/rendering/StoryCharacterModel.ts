import type { AdvCharacterModelEntry } from "../types/AdvRuntime";
import type { StoryResourceResolver } from "./StorySceneBackend";

export interface StoryCharacterModelContext {
  readonly target: string;
  readonly entry: AdvCharacterModelEntry;
  readonly resources: StoryResourceResolver;
  readonly signal: AbortSignal;
}

/**
 * Renderer-neutral presentation state owned by the ADV interpreter.
 *
 * Dynamic character adapters may consume this state without Vega importing
 * or redistributing their SDK. Values intentionally describe authored ADV
 * semantics instead of any one model format's parameter identifiers.
 */
export interface StoryCharacterPresentation {
  readonly alpha: number;
  readonly brightness: number;
  readonly blurIntensity: number;
  readonly angle: number;
  readonly bodyAngle: number;
  readonly lookX: number;
  readonly lookY: number;
  readonly lookEnabled: boolean;
  readonly lookTargetName: string;
  readonly paused: boolean;
  readonly playbackSpeed: number;
  readonly motionName: string;
  readonly expressionName: string;
  readonly rimLight: {
    readonly enabled: boolean;
    readonly color: unknown;
    readonly shadowIntensity: number;
  };
}

/**
 * Neutral lifecycle contract for a character surface owned by a scene backend.
 *
 * Vega's default implementation is a static HTML image. Dynamic character
 * systems are expected to live in independently distributed adapters.
 */
export interface StoryCharacterModel {
  readonly format: string;
  readonly source: string;
  readonly element: HTMLElement;
  readonly isOperational: boolean;
  setPaused(paused: boolean): void;
  setPlaybackSpeed(rate: number): void;
  /** Decode/parse one authored motion without selecting it for playback. */
  prepareMotion?(name: string): boolean | Promise<boolean>;
  /** Decode/parse one authored expression without selecting it. */
  prepareExpression?(name: string): boolean | Promise<boolean>;
  /** Submit one renderer-ready frame while the model is still off screen. */
  prepareFirstFrame?(): void | Promise<void>;
  playMotion?(name: string, fadeInSeconds?: number): boolean | Promise<boolean>;
  playExpression?(name: string, fadeInSeconds?: number): boolean | Promise<boolean>;
  /**
   * Receives the complete portable state after every authored presentation
   * mutation. A host adapter can map it to 2D skeletal, 3D, or proprietary
   * model parameters without exposing that runtime to Vega.
   */
  applyPresentation?(presentation: StoryCharacterPresentation): void | Promise<void>;
  /**
   * Resume resets expression-owned parameters before replaying the final
   * paused Motion/Expression, matching the native character lifecycle.
   */
  resetExpressionParameters?(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

/**
 * Small renderer-owned lifetime surface understood by Vega without knowing a
 * graphics API or model runtime.
 *
 * A provider may return a richer WebGL, Three, Pixi, native, or custom object.
 * The host owns that object after `createForRenderer` resolves. Disposal uses
 * the provider hook first, then exactly one conventional method in the order
 * `dispose`, `destroy`, `release`.
 */
export interface StoryCharacterRendererModel {
  dispose?(): void | Promise<void>;
  destroy?(): void | Promise<void>;
  release?(): void | Promise<void>;
}

/**
 * Renderer-aware construction request.
 *
 * Renderer ids are host-defined stable strings. Context is deliberately
 * generic so a WebGL host can expose a GL context, a Three host can expose its
 * renderer and scene services, and a Pixi host can expose its application
 * without coupling Vega to any of those libraries.
 */
export interface StoryCharacterRendererModelContext<
  TRendererId extends string = string,
  TRendererContext extends object = object,
> extends StoryCharacterModelContext {
  readonly renderer: TRendererId;
  readonly rendererContext: TRendererContext;
  readonly children?: {
    create(id: string, entry: AdvCharacterModelEntry): Promise<StoryCharacterRendererModel>;
    dispose(model: StoryCharacterRendererModel): void | Promise<void>;
  };
}

export interface StoryCharacterDescriptorPreparationContext {
  /** Source-neutral model entries accepted by this provider in story order. */
  readonly descriptors: readonly AdvCharacterModelEntry[];
  readonly resources: StoryResourceResolver;
  readonly signal: AbortSignal;
}

export type StoryCharacterResourceKind = "file" | "texture";
export type StoryCharacterResourceRole = "animation";

/** One directly addressable resource declared by a character provider. */
export interface StoryCharacterResource {
  readonly source: string;
  readonly kind?: StoryCharacterResourceKind;
  /** Lets the core preload story-selected animation bytes without allocating a model. */
  readonly role?: StoryCharacterResourceRole;
  readonly label?: string;
}

/**
 * ADV animation names referenced while a descriptor is active.
 *
 * An omitted usage means no animation selection was proven. Providers may
 * still enumerate base model dependencies, but must not infer that the whole
 * animation catalogue is needed.
 */
export interface StoryCharacterAnimationResourceUsage {
  readonly motions: readonly string[];
  readonly expressions: readonly string[];
}

export interface StoryCharacterResourceEnumerationContext {
  readonly entry: AdvCharacterModelEntry;
  readonly animationUsage?: StoryCharacterAnimationResourceUsage;
  readonly resources: StoryResourceResolver;
  readonly signal: AbortSignal;
  readonly enumerateChildResources?: (
    entry: AdvCharacterModelEntry,
    animationUsage?: StoryCharacterAnimationResourceUsage,
  ) => Promise<readonly StoryCharacterResource[]>;
}

export interface StoryCharacterProvider<
  TRendererId extends string = string,
  TRendererContext extends object = object,
  TRendererModel extends StoryCharacterRendererModel = StoryCharacterRendererModel,
> {
  readonly id: string;
  supports(entry: AdvCharacterModelEntry): boolean;
  /**
   * Optional story-level warmup. Providers may prepare shared runtimes from
   * the accepted descriptors before the scene allocates graphics resources.
   */
  prepareDescriptors?(context: StoryCharacterDescriptorPreparationContext): void | Promise<void>;
  /**
   * Enumerates directly addressable files without the ADV core interpreting
   * provider payload fields. Nested manifest discovery may instead happen in
   * `prepareDescriptors` through the same resource resolver.
   */
  enumerateResources?(
    context: StoryCharacterResourceEnumerationContext,
  ): readonly StoryCharacterResource[] | Promise<readonly StoryCharacterResource[]>;
  create(context: StoryCharacterModelContext): StoryCharacterModel | Promise<StoryCharacterModel>;
  /**
   * Optional renderer-owned construction path. Existing portable providers
   * only implement `create` and remain fully compatible.
   *
   * Callers should use `createRendererCharacterModel` so an abort that races
   * construction disposes a late result deterministically.
   */
  createForRenderer?(
    context: StoryCharacterRendererModelContext<TRendererId, TRendererContext>,
  ): TRendererModel | Promise<TRendererModel>;
  /**
   * Optional format-specific cleanup. When omitted, Vega falls back to the
   * conventional methods declared by `StoryCharacterRendererModel`.
   */
  disposeRendererModel?(
    model: TRendererModel,
    context: StoryCharacterRendererModelContext<TRendererId, TRendererContext>,
  ): void | Promise<void>;
}

export interface RendererAwareStoryCharacterProvider<
  TRendererId extends string = string,
  TRendererContext extends object = object,
  TRendererModel extends StoryCharacterRendererModel = StoryCharacterRendererModel,
> extends StoryCharacterProvider<TRendererId, TRendererContext, TRendererModel> {
  createForRenderer(
    context: StoryCharacterRendererModelContext<TRendererId, TRendererContext>,
  ): TRendererModel | Promise<TRendererModel>;
}

export const isRendererAwareCharacterProvider = <
  TRendererId extends string,
  TRendererContext extends object,
  TRendererModel extends StoryCharacterRendererModel,
>(
  provider: StoryCharacterProvider<TRendererId, TRendererContext, TRendererModel>,
): provider is RendererAwareStoryCharacterProvider<TRendererId, TRendererContext, TRendererModel> =>
  typeof provider.createForRenderer === "function";

const preparationAbortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Character provider preparation was aborted");
  error.name = "AbortError";
  return error;
};

/**
 * Prepare every provider once with only the descriptors it accepts.
 *
 * Descriptor identity is deduplicated without interpreting model formats.
 * Format-family deduplication remains provider-owned.
 */
export const prepareCharacterProviderDescriptors = async (
  providers: readonly StoryCharacterProvider[],
  descriptors: readonly AdvCharacterModelEntry[],
  resources: StoryResourceResolver,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw preparationAbortReason(signal);
  const uniqueDescriptors = [...new Set(descriptors)];
  await Promise.all(
    providers.map(async (provider) => {
      if (!provider.prepareDescriptors) return;
      const supported = uniqueDescriptors.filter((entry) => provider.supports(entry));
      if (!supported.length) return;
      if (signal.aborted) throw preparationAbortReason(signal);
      await provider.prepareDescriptors({
        descriptors: Object.freeze(supported),
        resources,
        signal,
      });
      if (signal.aborted) throw preparationAbortReason(signal);
    }),
  );
};

/**
 * Ask every accepting provider to enumerate resources for one descriptor.
 *
 * The provider owns format parsing. Vega only validates the portable
 * declaration shape; canonical URL validation remains at the resource-loader
 * boundary where every other story asset is checked.
 */
export const enumerateCharacterProviderResources = async (
  providers: readonly StoryCharacterProvider[],
  context: StoryCharacterResourceEnumerationContext,
  ancestors: readonly AdvCharacterModelEntry[] = [],
): Promise<readonly StoryCharacterResource[]> => {
  if (ancestors.length >= 32 || ancestors.includes(context.entry))
    throw new TypeError("Cyclic or excessively nested character resources");
  if (context.signal.aborted) throw preparationAbortReason(context.signal);
  const declarations = await Promise.all(
    providers.map(async (provider) => {
      if (!provider.enumerateResources || !provider.supports(context.entry)) {
        return [] as const;
      }
      if (context.signal.aborted) throw preparationAbortReason(context.signal);
      const provided = await provider.enumerateResources({
        ...context,
        enumerateChildResources: (entry, animationUsage) =>
          enumerateCharacterProviderResources(
            providers,
            {
              entry,
              resources: context.resources,
              signal: context.signal,
              ...(animationUsage ? { animationUsage } : {}),
            },
            [...ancestors, context.entry],
          ),
      });
      if (!Array.isArray(provided)) {
        throw new TypeError(`Character provider ${provider.id} returned a non-array resource declaration`);
      }
      return provided.map((resource) => {
        if (!resource || typeof resource.source !== "string" || !resource.source.trim()) {
          throw new TypeError(`Character provider ${provider.id} declared an empty resource source`);
        }
        if (resource.kind !== undefined && resource.kind !== "file" && resource.kind !== "texture") {
          throw new TypeError(`Character provider ${provider.id} declared an invalid resource kind`);
        }
        if (resource.role !== undefined && resource.role !== "animation") {
          throw new TypeError(`Character provider ${provider.id} declared an invalid resource role`);
        }
        if (resource.label !== undefined && (typeof resource.label !== "string" || !resource.label.trim())) {
          throw new TypeError(`Character provider ${provider.id} declared an invalid resource label`);
        }
        return Object.freeze({
          source: resource.source.trim(),
          ...(resource.kind ? { kind: resource.kind } : {}),
          ...(resource.role ? { role: resource.role } : {}),
          ...(resource.label ? { label: resource.label.trim() } : {}),
        });
      });
    }),
  );
  if (context.signal.aborted) throw preparationAbortReason(context.signal);
  return Object.freeze(declarations.flat());
};

const rendererAbortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Character renderer construction was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfRendererAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw rendererAbortReason(signal);
};

/**
 * Dispose a renderer-owned character exactly once through the provider's
 * explicit hook or a conventional model method.
 */
export const disposeRendererCharacterModel = async <
  TRendererId extends string,
  TRendererContext extends object,
  TRendererModel extends StoryCharacterRendererModel,
>(
  provider: StoryCharacterProvider<TRendererId, TRendererContext, TRendererModel>,
  model: TRendererModel,
  context: StoryCharacterRendererModelContext<TRendererId, TRendererContext>,
): Promise<void> => {
  if (provider.disposeRendererModel) {
    await provider.disposeRendererModel(model, context);
    return;
  }
  if (typeof model.dispose === "function") {
    await model.dispose();
    return;
  }
  if (typeof model.destroy === "function") {
    await model.destroy();
    return;
  }
  if (typeof model.release === "function") await model.release();
};

/**
 * Construct a renderer-owned character with deterministic abort cleanup.
 *
 * The request is rejected before provider work starts when already aborted.
 * If abort wins a race with a successfully constructed model, that model is
 * disposed before the abort reason is rethrown. A provider that allocates an
 * object and rejects without returning it remains responsible for that
 * private partial allocation.
 */
export const createRendererCharacterModel = async <
  TRendererId extends string,
  TRendererContext extends object,
  TRendererModel extends StoryCharacterRendererModel,
>(
  provider: RendererAwareStoryCharacterProvider<TRendererId, TRendererContext, TRendererModel>,
  context: StoryCharacterRendererModelContext<TRendererId, TRendererContext>,
): Promise<TRendererModel> => {
  throwIfRendererAborted(context.signal);
  let model: TRendererModel;
  try {
    model = await provider.createForRenderer(context);
  } catch (error) {
    if (context.signal.aborted) throw rendererAbortReason(context.signal);
    throw error;
  }
  if (!context.signal.aborted) return model;

  const reason = rendererAbortReason(context.signal);
  try {
    await disposeRendererCharacterModel(provider, model, context);
  } catch (cleanupError) {
    throw new AggregateError(
      [reason, cleanupError],
      `Failed to dispose aborted renderer character from ${provider.id}`,
    );
  }
  throw reason;
};
