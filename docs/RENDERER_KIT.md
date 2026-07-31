# Renderer kit

`@haneoka/vega/renderer-kit` is the stable boundary for independently
distributed scene renderers. It exposes renderer-neutral ADV state and shared
rendering algorithms without importing an application, character SDK, or
model asset.

## Character provider ABI

A `StoryCharacterProvider` always keeps its portable `create(context)` method.
It may additionally implement:

```ts
createForRenderer(context: StoryCharacterRendererModelContext):
  StoryCharacterRendererModel | Promise<StoryCharacterRendererModel>;

disposeRendererModel?(
  model: StoryCharacterRendererModel,
  context: StoryCharacterRendererModelContext,
): void | Promise<void>;
```

`StoryCharacterRendererModelContext` contains the ordinary target, entry,
resource resolver, and abort signal plus:

- `renderer`: a stable host-defined id such as `example.three-webgl2`;
- `rendererContext`: a typed object owned by that host.

The three generic parameters on `StoryCharacterProvider` describe the renderer
id, renderer context, and returned renderer model. This lets WebGL, Three,
Pixi, native, and future hosts share the same ABI without a graphics-library
type in Vega.

Backends should call `isRendererAwareCharacterProvider` and
`createRendererCharacterModel`, not invoke an optional method through a cast.
The helper checks the signal before construction. When construction resolves
after abort, it disposes the late object and rethrows the signal reason.

The cleanup order is fixed:

1. `provider.disposeRendererModel(model, context)`;
2. `model.dispose()`;
3. `model.destroy()`;
4. `model.release()`.

Only the first available path runs. A provider remains responsible for an
internal partial allocation that it rejects without returning.

## Renderer extensions

Every scene backend created by `VegaEngine` receives an immutable
`rendererExtensions` registry in `StorySceneBackendContext`. It contains the
active effect contributions and a typed service lookup:

```ts
const bloom = context.rendererExtensions?.effects.filter(
  (effect) => effect.effectType === "bloom",
);
const pipeline = context.rendererExtensions?.service(PIPELINE_SERVICE);
```

An effect receives `StoryRendererExtensionContext`: renderer id and host
context, runtime, player state, resource resolver, abort signal, and the same
typed service lookup. A backend decides which definitions and render phase it
supports. This keeps post-processing, particles, and platform-specific
pipelines outside both the opcode interpreter and an application repository.

## Shared primitives

The renderer-kit entry exports:

- complete public ADV runtime, command, quality, curve, particle, volume, and
  character-entry types;
- `AdvCamera`, ADV constants, easing, DoF, settling waits, and timeline
  helpers;
- `VegaLifetime` and renderer/resource/provider lifecycle contracts;
- renderer-neutral shake and frame-layout algorithms plus the portable
  seek-snapshot ABI;
- adaptive render quality and renderer/resource/provider lifecycle helpers;
- voice PCM, spectrum, analyzer, and portable viseme contracts;
- `DefaultStoryResourceResolver` and renderer effect/service ports.

Viewport policy, frame clocks, coordinate transforms, GPU target formats,
look-target sampling, pending renderer queues, DOM composition, video waits,
rain effects, texture caches, and rule-transition passes are implementation
details of renderer plugins. The official Three.js implementations are
exported by `@haneoka/vega-renderer-three`; Vega itself has no Three.js
dependency.

These exports are versioned with Vega. A renderer should import them from
`@haneoka/vega/renderer-kit`, never from `@haneoka/vega/src/...`.

## Framework players

`StoryPlayer` and `StoryPlayerFull` accept:

```ts
officialPlugins?: readonly VegaPlugin[];
renderBackend?: string;
```

When `officialPlugins` is present, even as an empty list, the component builds
an isolated plugin host. Render, character, resource, effect, command, and
service contributions are resolved together and disposed after the player.
Changing the preset or renderer restarts that component instance. Omitting the
property uses Vega's minimal built-in browser scene; no global renderer or
character-provider singleton is consulted.
