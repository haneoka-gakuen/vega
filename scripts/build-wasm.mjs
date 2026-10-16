import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generated = resolve(root, "src/generated");
mkdirSync(generated, { recursive: true });
for (const [command, args] of [
  ["cargo", ["build", "-p", "vega-wasm", "--release", "--target", "wasm32-unknown-unknown"]],
  [
    "wasm-bindgen",
    [
      "--target",
      "web",
      "--out-dir",
      generated,
      "--out-name",
      "vega_wasm",
      resolve(root, "target/wasm32-unknown-unknown/release/vega_wasm.wasm"),
    ],
  ],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
