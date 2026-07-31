# Vega

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

![Vega](docs/brand/header.svg)

**VEGA** — **V**isual-novel **E**ngine for **G**raphical **A**dventures

Vega is an extensible visual-novel engine for the web and native applications.
It turns a story project into an interactive experience while keeping the
renderer, character systems, themes, resources, and interface replaceable.

## What Vega does

- Plays dialogue, choices, scenes, animation, audio, video, and transitions.
- Supports save data, history, settings, and branching stories.
- Embeds in browser applications and works with Vue, React, and Web Components.
- Adds advanced rendering and character runtimes through plugins.

Vega ships without proprietary character SDKs or game assets. Projects provide
only the plugins and licensed runtime files they need.

## Try it

[First Light](https://github.com/haneoka-gakuen/vega-example-first-light) is an
editable example project that demonstrates the default Vega experience.

```sh
pnpm install
pnpm check
```

Use [Altair](https://github.com/haneoka-gakuen/altair) to create and localize a
project, then [Deneb](https://github.com/haneoka-gakuen/deneb) to build it for
the web, desktop, and mobile.

## License

Vega is available under MPL-2.0. Third-party components retain their own
licenses.
