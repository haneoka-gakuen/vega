import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const outputDirectory = new URL("../dist/deneb-runtime/", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);
const runtimeUrl = new URL("deneb-runtime.js", outputDirectory);
const manifestUrl = new URL("deneb-runtime.json", outputDirectory);
const sourceMapUrl = new URL("deneb-runtime.js.map", outputDirectory);
const legalFiles = ["LICENSE", "LICENSE-SCOPE.md", "THIRD_PARTY_NOTICES.md"];

for (const file of ["deneb-runtime.js", "deneb-runtime.json", ...legalFiles]) {
  const url = new URL(file, outputDirectory);
  if (!existsSync(url) || statSync(url).size === 0) {
    throw new Error(`Deneb runtime bundle is missing required file: ${file}`);
  }
}
if (existsSync(sourceMapUrl)) throw new Error("Production Deneb runtime must not include a source map");

const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
const packageManifest = JSON.parse(readFileSync(packageUrl, "utf8"));
if (packageManifest.files?.includes("deneb-runtime.json")) {
  throw new Error("The source Deneb manifest template must not be published at the npm package root");
}
if (
  manifest.format !== "vega-runtime" ||
  manifest.formatVersion !== 1 ||
  manifest.abiVersion !== 1 ||
  manifest.entrypoint !== "deneb-runtime.js"
) {
  throw new Error("Deneb runtime manifest does not match ABI v1");
}
for (const file of ["deneb-runtime.js", ...legalFiles]) {
  const expected = `sha256-${createHash("sha256")
    .update(readFileSync(new URL(file, outputDirectory)))
    .digest("hex")}`;
  if (manifest.integrity?.[file] !== expected) {
    throw new Error(`Deneb runtime integrity is missing or stale for ${file}`);
  }
}

const runtime = readFileSync(runtimeUrl);
const runtimeText = runtime.toString("utf8");
for (const notice of ["LICENSE-SCOPE.md", "THIRD_PARTY_NOTICES.md"]) {
  if (!runtimeText.includes(notice)) throw new Error(`Deneb runtime banner does not reference ${notice}`);
}
const runtimeModule = await import(runtimeUrl.href);
if (
  typeof runtimeModule.createDenebRuntime !== "function" ||
  typeof runtimeModule.vegaProjectToAdvStory !== "function" ||
  runtimeModule.DENEB_RUNTIME_ABI_VERSION !== 1 ||
  !Array.isArray(runtimeModule.DENEB_RUNTIME_CAPABILITIES)
) {
  throw new Error("Deneb runtime ESM exports do not satisfy ABI v1");
}
if (JSON.stringify(manifest.capabilities) !== JSON.stringify(runtimeModule.DENEB_RUNTIME_CAPABILITIES)) {
  throw new Error("Deneb runtime manifest capabilities do not match the bundled runtime");
}
for (const marker of ["haneoka.vega-shell-default", "haneoka.vega-portable-ui", "vega-default-toolbar__menu"]) {
  if (!runtimeText.includes(marker)) {
    continue;
  }
  throw new Error(`Deneb runtime unexpectedly bundled an implicit UI marker: ${marker}`);
}

const uncompressedBudget = 4 * 1024 * 1024;
const gzipBudget = 2 * 1024 * 1024;
const gzipBytes = gzipSync(runtime, { level: 9 }).byteLength;
if (runtime.byteLength > uncompressedBudget || gzipBytes > gzipBudget) {
  throw new Error(`Deneb runtime exceeds its budget: ${runtime.byteLength} bytes raw, ${gzipBytes} bytes gzip`);
}

console.log(`Deneb bundle verified: ${runtime.byteLength} bytes raw, ${gzipBytes} bytes gzip`);
