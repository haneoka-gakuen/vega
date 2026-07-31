import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const source = (file: string) => resolve(packageRoot, "src", file);
const legalBanner = `/*! Vega visual novel engine. See LICENSE and THIRD_PARTY_NOTICES.md. */`;

export default defineConfig({
  // This package is consumed from other applications. Asset URLs must remain
  // relative to the emitted module instead of resolving against a host's root.
  base: "./",
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith("md-") } } })],
  build: {
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: source("index.ts"),
        engine: source("engine-entry.ts"),
        marketplace: source("marketplace-entry.ts"),
        plugin: source("plugin-entry.ts"),
        shell: source("shell-entry.ts"),
        preview: source("preview-entry.ts"),
        "renderer-kit": source("renderer-kit-entry.ts"),
        runtime: source("runtime-entry.ts"),
        vue: source("vue-entry.ts"),
        "vue-controls": source("vue-controls-entry.ts"),
        "vue-player": source("vue-player-entry.ts"),
        "vue-text": source("vue-text-entry.ts"),
      },
      external: [
        /^@haneoka\/vega-protocol(?:\/|$)/,
        /^@lucide\/vue(?:\/|$)/,
        /^@material\/web(?:\/|$)/,
        "howler",
        "three",
        "vue",
      ],
      preserveEntrySignatures: "strict",
      output: {
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css")) ? "styles.css" : "assets/[name]-[hash][extname]",
        banner: legalBanner,
        entryFileNames: "[name].js",
        format: "es",
        preserveModules: true,
        preserveModulesRoot: resolve(packageRoot, "src"),
      },
    },
    minify: false,
    sourcemap: false,
    target: "es2022",
  },
});
