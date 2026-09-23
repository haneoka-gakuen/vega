import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifests = await Promise.all(
  [
    "package.json",
    "packages/protocol/package.json",
    "packages/react/package.json",
    "packages/web-component/package.json",
  ].map(async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"))),
);
const versions = new Set(manifests.map(({ version }) => version));

if (versions.size !== 1) {
  throw new Error("All packages in a Vega release must use the same version");
}

const [version] = versions;
const expected = `v${version}`;
const actual = process.env.RELEASE_TAG;

if (actual !== expected) {
  throw new Error(`GitHub release tag ${JSON.stringify(actual)} must equal ${expected}`);
}

console.log(`Verified release tag ${actual}.`);
