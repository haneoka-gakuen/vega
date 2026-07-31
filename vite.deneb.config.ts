import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const outputDirectory = resolve(packageRoot, "dist/deneb-runtime");
const legalFiles = [
  "LICENSE",
  "LICENSE-SCOPE.md",
  "THIRD_PARTY_NOTICES.md",
] as const;
const legalBanner = `/*!
 * Vega Deneb runtime bundle. Review LICENSE, LICENSE-SCOPE.md,
 * and THIRD_PARTY_NOTICES.md before redistribution.
 */`;

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@haneoka/vega/plugin": resolve(packageRoot, "src/plugin-entry.ts"),
      "@haneoka/vega/shell": resolve(packageRoot, "src/shell-entry.ts"),
    },
  },
  build: {
    assetsInlineLimit: 0,
    emptyOutDir: true,
    lib: {
      entry: resolve(packageRoot, "src/deneb-runtime-entry.ts"),
      fileName: () => "deneb-runtime.js",
      formats: ["es"],
    },
    minify: "esbuild",
    outDir: outputDirectory,
    rollupOptions: {
      output: {
        banner: legalBanner,
        inlineDynamicImports: true,
      },
    },
    // Deneb copies this whole directory into desktop/PWA distributions.
    // Production maps would add more than the runtime itself; debug builds can
    // opt into maps separately without silently shipping source by default.
    sourcemap: false,
    target: "es2022",
  },
  plugins: [
    {
      name: "vega-deneb-runtime-manifest",
      closeBundle() {
        mkdirSync(outputDirectory, { recursive: true });
        const entrypoint = resolve(outputDirectory, "deneb-runtime.js");
        const code = readFileSync(entrypoint, "utf8");
        // esbuild's production minifier removes Rollup banners, including
        // legal comments. Re-attach it after all output transforms.
        if (!code.startsWith(legalBanner)) writeFileSync(entrypoint, `${legalBanner}\n${code}`);
        for (const file of legalFiles) {
          copyFileSync(resolve(packageRoot, file), resolve(outputDirectory, file));
        }
        const manifest = JSON.parse(
          readFileSync(resolve(packageRoot, "deneb-runtime.json"), "utf8"),
        ) as Record<string, unknown>;
        manifest.integrity = Object.fromEntries(
          ["deneb-runtime.js", ...legalFiles].map((file) => {
            const digest = createHash("sha256")
              .update(readFileSync(resolve(outputDirectory, file)))
              .digest("hex");
            return [file, `sha256-${digest}`];
          }),
        );
        writeFileSync(
          resolve(outputDirectory, "deneb-runtime.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
      },
    },
  ],
});
