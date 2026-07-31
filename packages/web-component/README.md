# `@haneoka/vega-web-component`

Framework-neutral `<vega-player>` adapter for complete Vega projects and
legacy `AdvStory` values. Importing the package has no registration side
effect.

```ts
import {
  defineVegaPlayerElement,
  type VegaPlayerElement,
} from "@haneoka/vega-web-component";

defineVegaPlayerElement();

const player = document.querySelector<VegaPlayerElement>("vega-player")!;
player.autoStart = false;
player.appearance = "system";
player.engineOptions = { plugins: [rendererPlugin, themePlugin] };
player.playerOptions = { renderBackend: "portable" };
player.project = project;
player.shell = { projectId: project.id, title: "Summer" };
player.theme = "example.theme";

await player.ready;
await player.start();
player.pause();
await player.resume();
await player.dispose();
```

`project` compiles every scene and starts at `project.entryScene`; `sceneId`
selects another entry scene. Existing callers can keep assigning `story`.

`autoStart` defaults to `true`; `autoPlay` controls ADV automatic progression.
`appearance` accepts `light`, `system`, or `dark`, while `theme` is passed
unchanged to Vega's theme contribution selector.

The element exposes `handle`, `error`, `ready`, `start()`, `pause()`,
`resume()`, `reload()`, and `dispose()`. It emits composed `vega-ready` and
`vega-error` events. An injected `engine` remains caller-owned.

When it owns the engine, the element installs no presentation plugins. Supply
renderer, UI, shell, and theme plugins explicitly through `engineOptions`. An
injected engine is never modified. The element itself paints no dialogue,
choices, loading screen, or input layer; renderer, theme, and UI-slot
contributions are the single visual presentation.
