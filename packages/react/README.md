# `@haneoka/vega-react`

React adapter for complete Vega projects and legacy `AdvStory` values. It does
not load Vue.

```tsx
import { createRef } from "react";
import { VegaPlayer, type VegaPlayerController } from "@haneoka/vega-react";

const player = createRef<VegaPlayerController>();

<VegaPlayer
  ref={player}
  project={project}
  appearance="system"
  engineOptions={{ plugins: [rendererPlugin, themePlugin] }}
  playerOptions={{ renderBackend: "portable" }}
  shell={{ projectId: project.id, title: "Summer" }}
  theme="example.theme"
  onError={console.error}
/>;
```

`project` compiles every scene and starts at `project.entryScene`; `sceneId`
selects another entry scene. Existing callers can keep passing `story`.

`autoStart` defaults to `true`. Set it to `false` for host-controlled startup:

```ts
await player.current?.ready();
await player.current?.start();
player.current?.pause();
await player.current?.resume();
await player.current?.dispose();
```

`appearance` controls only the host color scheme and accepts `light`, `system`,
or `dark`. `theme` is passed unchanged to Vega's theme contribution selector.
An injected `engine` remains owned by the caller; an adapter-created engine is
disposed with the component.

When it owns the engine, the adapter installs no presentation plugins. Supply
renderer, UI, shell, and theme plugins explicitly through `engineOptions`. An
injected engine is never modified. The React adapter itself paints no dialogue,
choices, loading screen, or input layer; renderer, theme, and UI-slot
contributions are the single visual presentation.
