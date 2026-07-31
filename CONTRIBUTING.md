# Contributing to Vega

Vega preserves an existing command language while extracting it into a host-neutral engine. Changes should therefore be small, reviewable, and backed by a contract or lifecycle test.

## Development

Use Node.js 20 or newer and the pnpm version declared in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm pack --dry-run
```

Before opening a pull request:

- do not renumber or reinterpret opcodes `0–100`;
- add protocol fixtures for serialized format changes;
- prove ownership and reverse-order cleanup for lifecycle changes;
- keep framework integrations outside the engine core;
- document capability loss instead of silently discarding data;
- avoid adding game-derived assets or code without redistribution evidence.

Protocol and public API breaks require a migration note and a major-version proposal. New official commands belong in `501–999`; third-party commands must use the allocator-defined range at `10000` or above.

## Changes and licensing

Use focused commits and include the source and license of any vendored material in the relevant notice. By contributing, you agree that your contribution may be distributed under the license applying to the files you modify.
