# Vega

Vega is the story engine for web and native visual-novel players. It turns an
`AdvStory` command stream into player state, resource requests, audio requests,
choices, save data, and renderer-neutral scene state. Hosts choose the renderer,
UI, audio, storage, character runtimes, and resource adapters through plugins.

## What you get

- Native ADV commands for dialogue, choices, scenes, characters, backgrounds,
  stills, video, audio, transitions, chat, camera motion, and post effects.
- Branching narrative state, backlog, settings, save/load storage, flowchart
  metadata, deterministic seek checkpoints, and replay-aware command plugins.
- A DOM fallback scene for a portable player and plugin ports for Three.js,
  Cubism, other character runtimes, audio, input, themes, and UI slots.
- Vue components plus React and Web Component packages in the Vega workspace.

Vega consumes story data and host-provided resources. A story carries command
objects such as `{ command: 2, targetName: "Guide", text: "Hello" }`; a resource
field carries a canonical URL such as `/stories/episode-1/bg/room.png` or an
HTTPS URL. `DefaultStoryResourceResolver` handles HTTP(S), `data:`, and `blob:`
URLs directly; native hosts add an adapter for `file:` URLs, archives, and
application protocols.

## Build from a clean source checkout

The current player stack is consumed from Git workspaces. The packages at these
revisions are source checkouts, so a consumer workspace must link them locally.
The Vega repository contains its protocol, React, and Web Component workspaces.

```sh
mkdir vega-player-workspace
cd vega-player-workspace
git clone https://github.com/haneoka-gakuen/vega.git packages/vega
mkdir -p app
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - app
  - packages/vega
  - packages/vega/packages/*
linkWorkspacePackages: true
```

Create `app/package.json` with the local dependency:

```json
{
  "name": "vega-player-demo",
  "private": true,
  "type": "module",
  "dependencies": {
    "@haneoka/vega": "workspace:*",
    "@haneoka/vega-protocol": "workspace:*"
  }
}
```

Install and build the engine:

```sh
corepack enable
corepack prepare pnpm@11.14.0 --activate
pnpm install
pnpm --filter @haneoka/vega build:core
```

For a release-quality package check, run `pnpm --filter @haneoka/vega check`.
The repository requires Node 20 or newer.

## Smallest complete browser player

This example uses the built-in DOM scene and no optional plugin. Put a
`<div id="player"></div>` and `<pre id="output"></pre>` in the page, then run
the module through your browser bundler.

```ts
import { VegaEngine } from "@haneoka/vega/engine";
import { VEGA_ADV_OPCODE } from "@haneoka/vega-protocol/opcodes";

const mount = document.querySelector<HTMLElement>("#player");
const output = document.querySelector<HTMLElement>("#output");
if (!mount || !output) throw new Error("The page needs #player and #output");

const engine = new VegaEngine({ id: "hello-vega" });
const player = await engine.createPlayer({
  mount,
  story: {
    commands: [
      {
        command: VEGA_ADV_OPCODE.Talk,
        targetName: "Guide",
        text: "Hello from Vega.",
        noWait: true
      }
    ]
  }
});

await player.player.play();
output.textContent = JSON.stringify(
  {
    ready: player.player.state.ready,
    finished: player.player.state.finished,
    dialogue: player.player.state.talkLog.at(-1)?.text
  },
  null,
  2
);

await player.dispose();
await engine.dispose();
```

`createPlayer()` starts the engine, creates a player root under `mount`, boots
the story, prepares resources, and returns a `VegaPlayerHandle`. The player
reads `story.commands`, mutates the reactive `state`, and exposes playback
methods such as `play()`, `pause()`, `resume()`, `requestNext()`, `choose(key)`,
and `seekTo(index)`. The returned handle owns the player lifetime; dispose it
before disposing the engine. Engine disposal also disposes every active player,
plugin registration, input subscription, and storage port.

## Renderer, host, and plugin roles

Vega separates the interpreter from presentation:

- The engine and `AdvPlayer` execute commands and own narrative state.
- A render plugin contributes a `StorySceneBackend`. With no render plugin,
  Vega uses the portable `GenericStoryScene` DOM backend.
- UI-slot plugins consume `AdvPlayerState` and mount dialogue, controls, shells,
  choices, chat, and status surfaces under the player root.
- Character plugins claim model entries and own their SDK/runtime resources.
- Audio, input, storage, and resource plugins implement host capabilities.

Install plugins before `start()` or pass them to the constructor:

```ts
const engine = new VegaEngine({
  plugins: [myAudioPlugin, myInputPlugin, myStoragePlugin]
});
await engine.start();
```

Use `officialPlugins` only for plugins trusted as part of the Vega distribution.
Application plugins belong in `plugins` and receive third-party authority.
Plugin setup registrations are scoped to the engine and roll back on failure.

## Resources and customization

The default resolver handles ordinary web URLs. Add an adapter for an archive or
desktop protocol by contributing a resource port with a scheme and a `load`
method. A renderer receives that resolver through `StorySceneBackendContext`.
Use `configureStoryRuntime()` for host localization and canonical URL policy:

```ts
import { configureStoryRuntime } from "@haneoka/vega/runtime";

configureStoryRuntime({
  localize: (value) => typeof value === "string" ? value : "",
  message: (key) => ({ loading: "Loading…", play: "Start" }[key] ?? key)
});
```

Story URLs must stay inside the host's authorized resource scope. Vega rejects
empty, traversal-based, and unsafe relative URLs before loading them. A host
that serves licensed media should resolve the story's logical paths to release
URLs and keep that mapping in its resource or theme plugin.

## License

Vega is available under [MPL-2.0](LICENSE). The scope and attribution details
are in [LICENSE-SCOPE.md](LICENSE-SCOPE.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Third-party runtimes and game
media retain their own licenses.
