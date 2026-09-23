import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(
  process.argv[2] ?? process.env.VEGA_DISTRIBUTION_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
);
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const normalized = (value) => value.split("\\").join("/");
const violations = [];

const forbiddenPathPatterns = [
  /(?:^|\/)vendor\/(?:cubism|live2d)(?:\/|$)/i,
  /(?:^|\/)CubismSdkFor[^/]*(?:\/|$)/i,
  /(?:^|\/)(?:live2dcubismcore|live2dcubismmotionsynccore|motionsynccore)(?:\.min)?\.(?:js|wasm|dll|dylib|so|a|lib)$/i,
  /\.(?:moc3?|model(?:3)?\.json|motion(?:3)?\.json|physics(?:3)?\.json|pose(?:3)?\.json|cdi3\.json)$/i,
  /(?:^|\/)adv-chat-common(?:\/|$)/i,
  /(?:^|\/)assets\/urp\/film-grain(?:\/|$)/i,
  /(?:^|\/)prepare_urp_(?:shaders|textures)\.py$/i,
  /(?:^|\/)AdvHdrLutShaders\./i,
  /(?:^|\/)UnityColorUtils\./i,
  /^src\/rendering\/three(?:\/|$)/i,
  ...(manifest.name === "@haneoka/vega" ? [/^dist\/.*\.map$/i] : []),
  /(?:^|\/)dist\/.*\.(?:test|spec)(?:\.[^/]+)+$/i,
];

const forbiddenContentPatterns = [
  /Live2D Proprietary Software License Agreement/i,
  /src\/vendor\/(?:cubism|live2d)/i,
  /assets\/adv-chat-common/i,
  /assets\/urp\/film-grain/i,
  /(?:\bfrom\s*|\bimport\s*\(\s*)["']three(?:\/[^"']*)?["']/i,
];
const isLegalNotice = (path) => path === "THIRD_PARTY_NOTICES.md" || path.endsWith("/THIRD_PARTY_NOTICES.md");

// Known removed binary payloads. Renaming one must not bypass the path gate.
const forbiddenAssetHashes = new Set([
  "2a570f",
  "1af8a3",
  "32a83e",
  "dd46f9",
  "c7613b",
  "6f828c",
  "4252f9",
  "bd5053",
  "3e2eb1",
  "f1b763",
  "4dd72a",
  "d187e1",
  "8e5a55",
  "97d442",
  "d73851",
  "dd7aeb",
  "6caabf",
  "43582c",
]);

const ignoredDirectories = new Set([".git", "node_modules", ".turbo", "coverage"]);
const rootsToScan = [
  "src",
  "packages",
  "scripts",
  "dist",
  "docs",
  "package.json",
  "vite.config.ts",
  "vite.deneb.config.ts",
  "README.md",
  "LICENSE-SCOPE.md",
  "THIRD_PARTY_NOTICES.md",
];

const isText = (path) =>
  /\.(?:[cm]?[jt]sx?|vue|json|md|css|scss|html|d\.ts|map|txt|yml|yaml)$/i.test(path) || !/\.[a-z0-9]+$/i.test(path);

const visit = (absolutePath) => {
  if (!existsSync(absolutePath)) return;
  const stats = statSync(absolutePath);
  if (stats.isDirectory()) {
    if (ignoredDirectories.has(absolutePath.split("/").at(-1))) return;
    for (const name of readdirSync(absolutePath)) visit(resolve(absolutePath, name));
    return;
  }
  const path = normalized(relative(root, absolutePath));
  for (const pattern of forbiddenPathPatterns) {
    if (pattern.test(path)) violations.push(`${path}: forbidden distribution path (${pattern})`);
  }
  const bytes = readFileSync(absolutePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if ([...forbiddenAssetHashes].some((prefix) => digest.startsWith(prefix))) {
    violations.push(`${path}: matches a removed restricted asset (${digest})`);
  }
  if (path === "scripts/verify-distribution.mjs") return;
  // Legal notices may name excluded providers to make the distribution
  // boundary explicit. They remain subject to path and binary hash checks.
  if (isLegalNotice(path)) return;
  if (!isText(path) || bytes.includes(0)) return;
  const content = bytes.toString("utf8");
  for (const pattern of forbiddenContentPatterns) {
    if (pattern.test(content)) violations.push(`${path}: forbidden distribution content (${pattern})`);
  }
};

for (const path of rootsToScan) visit(resolve(root, path));

const collectExportTargets = (value) => {
  if (typeof value === "string") return value.startsWith("./") ? [value] : [];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectExportTargets);
};
const exportTargets = new Set(
  [manifest.main, manifest.module, manifest.types, ...collectExportTargets(manifest.exports)].filter(
    (value) => typeof value === "string" && value.startsWith("./"),
  ),
);
for (const target of exportTargets) {
  if (!existsSync(resolve(root, target))) {
    violations.push(`package.json: export target does not exist (${target})`);
  }
}
if (
  (manifest.files ?? []).some((path) =>
    /(?:vendor\/(?:cubism|live2d)|CubismSdkFor|adv-chat-common|film-grain|\.(?:moc3?|model(?:3)?\.json|motion(?:3)?\.json))/i.test(
      path,
    ),
  )
) {
  violations.push("package.json: forbidden restricted SDK or asset path");
}
for (const dependencyField of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  const dependencies = manifest[dependencyField] ?? {};
  for (const dependency of ["three", "@types/three"]) {
    if (Object.hasOwn(dependencies, dependency)) {
      violations.push(`package.json: ${dependencyField} must not contain graphics adapter dependency ${dependency}`);
    }
  }
}

if (violations.length) {
  console.error(`Vega distribution verification failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Vega distribution verified: no restricted SDK, runtime, extracted asset, or stale export found.");
}
