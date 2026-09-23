import { isVegaCommandType } from "./opcodes.js";
import type { VegaAsset, VegaCommand, VegaJsonValue, VegaProject, VegaScene } from "./model.js";
import {
  parseVegaLocalizedText,
  parseVegaProjectLocalization,
  VEGA_PROJECT_LOCALIZATION_METADATA_KEY,
  VegaLocalizationParseError,
} from "./localization.js";
import { assertVegaProjectPlugin, VegaPluginProtocolError } from "./plugin.js";

export type { VegaProject } from "./model.js";

export const VEGA_PROJECT_MAX_BYTES = 32 * 1024 * 1024;
export const VEGA_PROJECT_MAX_DEPTH = 128;
export const VEGA_PROJECT_MAX_NODES = 1_000_000;

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROJECT_KEYS = new Set([
  "format",
  "formatVersion",
  "id",
  "title",
  "entryScene",
  "engine",
  "metadata",
  "assets",
  "plugins",
  "scenes",
]);
const SCENE_KEYS = new Set(["id", "title", "commands", "metadata"]);
const ASSET_KEYS = new Set(["type", "source", "hash", "mediaType", "bytes", "variants"]);
const ASSET_TYPES = new Set(["image", "audio", "video", "model", "font", "data", "other"]);

export class VegaProjectParseError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "VegaProjectParseError";
    this.path = path;
  }
}

export const parseVegaProject = (input: string | Uint8Array | unknown): VegaProject => {
  let value: unknown = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > VEGA_PROJECT_MAX_BYTES) {
      throw new VegaProjectParseError("$", `project exceeds ${VEGA_PROJECT_MAX_BYTES} bytes`);
    }
    value = parseJson(input);
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > VEGA_PROJECT_MAX_BYTES) {
      throw new VegaProjectParseError("$", `project exceeds ${VEGA_PROJECT_MAX_BYTES} bytes`);
    }
    value = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(input));
  }
  assertVegaProject(value);
  return normalizeProjectLocalization(value);
};

export function assertVegaProject(value: unknown): asserts value is VegaProject {
  const budget = { nodes: VEGA_PROJECT_MAX_NODES };
  assertSafeJson(value, "$", 0, budget);
  const project = requireRecord(value, "$");
  rejectUnknownKeys(project, PROJECT_KEYS, "$");
  if (project.format !== "vega-project") fail("$.format", "expected `vega-project`");
  if (project.formatVersion !== 1) fail("$.formatVersion", "expected version 1");
  requireNonEmptyString(project.id, "$.id");
  assertLocalizedText(project.title, "$.title");
  requireNonEmptyString(project.entryScene, "$.entryScene");

  if (project.engine !== undefined) {
    const engine = requireRecord(project.engine, "$.engine");
    rejectUnknownKeys(engine, new Set(["minimumVersion", "features"]), "$.engine");
    if (engine.minimumVersion !== undefined) requireNonEmptyString(engine.minimumVersion, "$.engine.minimumVersion");
    if (engine.features !== undefined) assertStringArray(engine.features, "$.engine.features");
  }
  let assets: Readonly<Record<string, VegaAsset>> = {};
  let localizationEnabled = false;
  if (project.assets !== undefined) {
    const assetValues = requireRecord(project.assets, "$.assets");
    for (const [key, asset] of Object.entries(assetValues)) {
      assertAsset(asset, `$.assets.${key}`);
    }
    assets = assetValues as Record<string, VegaAsset>;
  }
  if (project.metadata !== undefined) {
    const metadata = requireRecord(project.metadata, "$.metadata");
    const localization = metadata[VEGA_PROJECT_LOCALIZATION_METADATA_KEY];
    if (localization !== undefined) {
      const path = `$.metadata[${JSON.stringify(VEGA_PROJECT_LOCALIZATION_METADATA_KEY)}]`;
      parseLocalizationAt(path, () => {
        parseVegaProjectLocalization(localization, assets);
      });
      localizationEnabled = true;
    }
  }
  if (project.plugins !== undefined) {
    if (!Array.isArray(project.plugins)) fail("$.plugins", "expected an array");
    project.plugins.forEach((plugin, index) => {
      const path = `$.plugins[${index}]`;
      try {
        assertVegaProjectPlugin(plugin, path);
      } catch (error) {
        if (error instanceof VegaPluginProtocolError) {
          const prefix = `${error.path}: `;
          throw new VegaProjectParseError(
            error.path,
            error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message,
          );
        }
        throw error;
      }
    });
  }

  const scenes = requireRecord(project.scenes, "$.scenes");
  for (const [key, scene] of Object.entries(scenes)) assertScene(scene, `$.scenes.${key}`);
  if (!Object.hasOwn(scenes, project.entryScene as string)) {
    fail("$.entryScene", `scene ${JSON.stringify(project.entryScene)} does not exist`);
  }
  if (localizationEnabled) {
    parseLocalizationAt("$.title", () => parseVegaLocalizedText(project.title));
    for (const [key, scene] of Object.entries(scenes)) {
      const title = (scene as Record<string, unknown>).title;
      if (title !== undefined) {
        parseLocalizationAt(`$.scenes.${key}.title`, () => parseVegaLocalizedText(title));
      }
    }
  }
}

const normalizeProjectLocalization = (project: VegaProject): VegaProject => {
  const rawLocalization = project.metadata?.[VEGA_PROJECT_LOCALIZATION_METADATA_KEY];
  if (rawLocalization === undefined) return project;

  const localization = parseVegaProjectLocalization(rawLocalization, project.assets ?? {});
  const scenes = Object.fromEntries(
    Object.entries(project.scenes).map(([key, scene]) => [
      key,
      scene.title === undefined ? scene : { ...scene, title: parseVegaLocalizedText(scene.title) },
    ]),
  );
  return {
    ...project,
    title: parseVegaLocalizedText(project.title),
    metadata: {
      ...project.metadata,
      [VEGA_PROJECT_LOCALIZATION_METADATA_KEY]: localization,
    },
    scenes,
  };
};

const parseLocalizationAt = <Value>(path: string, parse: () => Value): Value => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof VegaLocalizationParseError) {
      throw new VegaProjectParseError(error.path === "$" ? path : `${path}${error.path.slice(1)}`, error.reason);
    }
    throw error;
  }
};

function assertScene(value: unknown, path: string): asserts value is VegaScene {
  const scene = requireRecord(value, path);
  rejectUnknownKeys(scene, SCENE_KEYS, path);
  requireNonEmptyString(scene.id, `${path}.id`);
  if (scene.title !== undefined) assertLocalizedText(scene.title, `${path}.title`);
  if (!Array.isArray(scene.commands)) fail(`${path}.commands`, "expected an array");
  scene.commands.forEach((command, index) => assertCommand(command, `${path}.commands[${index}]`));
  if (scene.metadata !== undefined) requireRecord(scene.metadata, `${path}.metadata`);
}

function assertCommand(value: unknown, path: string): asserts value is VegaCommand {
  const command = requireRecord(value, path);
  if (!isVegaCommandType(command.command) && (!Number.isSafeInteger(command.command) || Number(command.command) < 0)) {
    fail(`${path}.command`, "expected a native opcode or a qualified plugin command type");
  }
  if (command.index !== undefined && (!Number.isSafeInteger(command.index) || Number(command.index) < 0)) {
    fail(`${path}.index`, "expected a non-negative safe integer");
  }
  if (command.key !== undefined) requireNonEmptyString(command.key, `${path}.key`);
  if (command.name !== undefined && typeof command.name !== "string") fail(`${path}.name`, "expected a string");
  if (command.noWait !== undefined && typeof command.noWait !== "boolean") {
    fail(`${path}.noWait`, "expected a boolean");
  }
}

function assertAsset(value: unknown, path: string): asserts value is VegaAsset {
  const asset = requireRecord(value, path);
  rejectUnknownKeys(asset, ASSET_KEYS, path);
  if (typeof asset.type !== "string" || !ASSET_TYPES.has(asset.type)) fail(`${path}.type`, "unsupported asset type");
  requireNonEmptyString(asset.source, `${path}.source`);
  if (asset.hash !== undefined) requireNonEmptyString(asset.hash, `${path}.hash`);
  if (asset.mediaType !== undefined) requireNonEmptyString(asset.mediaType, `${path}.mediaType`);
  if (asset.bytes !== undefined && (!Number.isSafeInteger(asset.bytes) || Number(asset.bytes) < 0)) {
    fail(`${path}.bytes`, "expected a non-negative safe integer");
  }
  if (asset.variants !== undefined) {
    const variants = requireRecord(asset.variants, `${path}.variants`);
    for (const [key, source] of Object.entries(variants)) requireNonEmptyString(source, `${path}.variants.${key}`);
  }
}

const assertLocalizedText = (value: unknown, path: string): void => {
  if (typeof value === "string") return;
  const localized = requireRecord(value, path);
  if (!Object.keys(localized).length) fail(path, "localized text cannot be empty");
  for (const [locale, text] of Object.entries(localized)) {
    if (typeof text !== "string") fail(`${path}.${locale}`, "expected a string");
  }
};

const assertStringArray = (value: unknown, path: string): void => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(path, "expected an array of strings");
  }
};

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain object");
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "expected a non-empty string");
  if (!value.trim()) fail(path, "expected a non-empty string");
  return value;
}

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
};

function assertSafeJson(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): asserts value is VegaJsonValue {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > VEGA_PROJECT_MAX_DEPTH) fail(path, "JSON structure is too complex");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "numbers must be finite");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJson(entry, `${path}[${index}]`, depth + 1, budget));
    return;
  }
  const record = requireRecord(value, path);
  for (const [key, entry] of Object.entries(record)) {
    if (DANGEROUS_KEYS.has(key)) fail(`${path}.${key}`, "dangerous property name");
    assertSafeJson(entry, `${path}.${key}`, depth + 1, budget);
  }
}

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new VegaProjectParseError("$", error instanceof Error ? error.message : "invalid JSON");
  }
};

function fail(path: string, message: string): never {
  throw new VegaProjectParseError(path, message);
}
