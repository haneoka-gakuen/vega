# `@haneoka/vega-protocol`

Stable project and binary-bundle protocol for Vega, Altair, Deneb, and
third-party tools.

- `*.vega.json` is the readable, versioned authoring/interchange form.
- `*.vgb` is the MessagePack release form with a Vega magic header.
- Native ADV opcodes `0..100` retain their original meanings.
- Opcodes `101..499` are reserved for future native semantics.
- Opcode `500` remains the native concurrent command group.
- Vega built-ins extend through `501..999`, `1000..9999` remain reserved,
  and third-party commands start at `10000`.

Project plugin declarations remain compatible with the original
`{ id, version, required, configuration }` shape. Protocol v1 also defines
capabilities, permissions, dependencies, runtime targets, install-source
metadata, marketplace entries, and deterministic `vega-plugin-lock` files.
Parsing and validation are exported from `@haneoka/vega-protocol/plugin`.

Project format 1 retains inline character descriptors. Format 2 adds shared
character definitions in `metadata["vega:characterModels"]`; commands refer to
one definition with `characterModelRef`. Definitions use the same provider
fields as inline models. Native command groups and timeline signals can carry
references too. Writers emit format 2 when they use these references, so older
format-1 players reject the project before playback. Current players continue
to read format-1 projects. The binary bundle envelope remains version 1.

The general JSON schema accepts both project versions; the version-specific
schemas are exported as `schema/vega-project-v1.json` and
`schema/vega-project-v2.json`. Preview runtimes advertise `modelDefinitions`;
clients require that capability before sending a shared model registry.
