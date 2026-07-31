# Vega editor preview protocol

Vega exposes editor preview through the versioned
`haneoka.vega.preview.v1` contract in `@haneoka/vega-protocol/preview`.
The runtime accepts only a transferred `MessagePort`; the application that
bootstraps the port is responsible for authenticating the editor session and
checking its exact origin. The runtime does not listen for wildcard window
messages.

## Ordering and cancellation

Every request carries a monotonically increasing numeric `revision`. A request
older than the latest observed revision is answered with `superseded`. Work
that accepts an `AbortSignal`, such as snippet execution, is cancelled
immediately. Player creation cannot always abort an underlying resource
provider, so a stale player is disposed before it can become the active scene.
No state event from the old player is published under the newer revision.

`editor.sync-scene` also carries a string `sceneRevision`. This identifies the
editor document used for transform baselines and diagnostics; it does not
replace the envelope revision used for request ordering.

## Scene execution

| Command | Behaviour |
| --- | --- |
| `editor.sync-scene` | Atomically boots a scene and optionally reconstructs a command boundary without starting playback. |
| `editor.run-scene` | Reboots the last synced scene at command zero (or the supplied boundary) and starts playback. |
| `editor.run-from` | Reconstructs the last synced scene at a command boundary and starts playback there. |
| `editor.run-snippet` | Executes typed ADV commands against the active stage and narrative store without replacing the story or moving its cursor. |

`runtime.load`, `runtime.seek`, `runtime.play`, and `runtime.pause` remain
available for older clients. Scene reconstruction uses the same deterministic
seek/checkpoint implementation as the player, rather than a second editor-only
interpreter.

## Debugger

`debug.breakpoints.set` replaces the breakpoint set. Breakpoints may be scoped
to a `sceneId`; an omitted scene applies to the active scene. `debug.continue`
resumes the real player loop. `debug.step` lets exactly one command finish and
then pauses at the next command boundary. `runtime.stopped` reports `pause`,
`breakpoint`, `step`, or `end`.

The player offers a multi-subscriber command-boundary port:

```ts
const unsubscribe = player.subscribeExecutionObserver((boundary) => {
  // boundary.phase: "before" | "started" | "after"
});
```

This keeps preview, application shell, and plugin observers independent.
`debug.variables` returns the active `VegaNarrativeStore` variables, not a
synthetic debugger map.

## Stage inspection

`stage.snapshot` returns the active scene/document identity, command cursor,
execution flags, breakpoints, narrative state, variables, player state, camera,
and mounted target list.

Portable DOM targets use these names:

- `stage` and `camera`
- `layer:background`, `layer:characters`, `layer:still`, `layer:video`,
  `layer:frame`, and `layer:cover`
- `character:<authored target name>`

`stage.reference-frame` measures the mounted target relative to the actual
preview mount. `stage.transform.get` reads the real camera or DOM transform.
`stage.transform.set` edits position, uniform camera scale (or per-axis DOM
scale), rotation, and opacity. A renderer that cannot expose a requested target
returns `missing` or `unsupported` instead of invented geometry.
