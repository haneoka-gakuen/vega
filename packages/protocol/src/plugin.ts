import type {
  VegaJsonValue,
  VegaExternalRuntimeRequirement,
  VegaPluginInstallSource,
  VegaPluginCatalog,
  VegaPluginLock,
  VegaPluginLockEntry,
  VegaPluginLockTarget,
  VegaPluginMarketplaceEntry,
  VegaPluginTargets,
  VegaProjectPlugin,
} from "./model.js";

const MAX_PROTOCOL_BYTES = 32 * 1024 * 1024;
const MAX_PROTOCOL_DEPTH = 128;
const MAX_PROTOCOL_NODES = 1_000_000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;

const PROJECT_PLUGIN_KEYS = new Set([
  "id",
  "version",
  "required",
  "configuration",
  "capabilities",
  "permissions",
  "dependencies",
  "targets",
  "source",
]);
const MARKETPLACE_ENTRY_KEYS = new Set([
  "format",
  "formatVersion",
  "id",
  "name",
  "version",
  "apiVersion",
  "description",
  "publisher",
  "tags",
  "capabilities",
  "permissions",
  "dependencies",
  "optionalDependencies",
  "externalRuntimes",
  "targets",
  "source",
  "integrity",
]);
const CATALOG_KEYS = new Set(["format", "formatVersion", "id", "plugins"]);
const TARGET_KEYS = new Set(["runtimes", "platforms", "architectures", "engineVersion", "apiVersions"]);
const LOCK_KEYS = new Set(["format", "formatVersion", "projectFormatVersion", "target", "plugins"]);
const LOCK_TARGET_KEYS = new Set(["runtime", "platform", "architecture", "engineVersion", "apiVersion"]);
const LOCK_ENTRY_KEYS = new Set([
  "id",
  "version",
  "source",
  "integrity",
  "dependencies",
  "capabilities",
  "permissions",
  "externalRuntimes",
]);
const EXTERNAL_RUNTIME_KEYS = new Set(["id", "name", "version", "license", "homepage", "optional", "provisioning"]);

export class VegaPluginProtocolError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "VegaPluginProtocolError";
    this.path = path;
  }
}

export const parseVegaProjectPlugin = (input: string | Uint8Array | unknown): VegaProjectPlugin => {
  const value = parseInput(input);
  assertVegaProjectPlugin(value);
  return value;
};

export const parseVegaPluginMarketplaceEntry = (input: string | Uint8Array | unknown): VegaPluginMarketplaceEntry => {
  const value = parseInput(input);
  assertVegaPluginMarketplaceEntry(value);
  return value;
};

export const parseVegaPluginCatalog = (input: string | Uint8Array | unknown): VegaPluginCatalog => {
  const value = parseInput(input);
  assertVegaPluginCatalog(value);
  return value;
};

export const parseVegaPluginLock = (input: string | Uint8Array | unknown): VegaPluginLock => {
  const value = parseInput(input);
  assertVegaPluginLock(value);
  return value;
};

export function assertVegaProjectPlugin(value: unknown, path = "$"): asserts value is VegaProjectPlugin {
  assertSafeJson(value, path, 0, { nodes: MAX_PROTOCOL_NODES });
  const plugin = requireRecord(value, path);
  rejectUnknownKeys(plugin, PROJECT_PLUGIN_KEYS, path);
  requirePluginId(plugin.id, `${path}.id`);
  requireNonEmptyString(plugin.version, `${path}.version`);
  if (plugin.required !== undefined && typeof plugin.required !== "boolean") {
    fail(`${path}.required`, "expected a boolean");
  }
  if (plugin.configuration !== undefined) {
    requireRecord(plugin.configuration, `${path}.configuration`);
  }
  if (plugin.capabilities !== undefined) {
    assertStringArray(plugin.capabilities, `${path}.capabilities`);
  }
  if (plugin.permissions !== undefined) {
    assertStringArray(plugin.permissions, `${path}.permissions`);
  }
  if (plugin.dependencies !== undefined) {
    assertDependencies(plugin.dependencies, `${path}.dependencies`);
  }
  if (plugin.targets !== undefined) {
    assertVegaPluginTargets(plugin.targets, `${path}.targets`);
  }
  if (plugin.source !== undefined) {
    assertVegaPluginInstallSource(plugin.source, `${path}.source`);
  }
}

export function assertVegaPluginMarketplaceEntry(
  value: unknown,
  path = "$",
): asserts value is VegaPluginMarketplaceEntry {
  assertSafeJson(value, path, 0, { nodes: MAX_PROTOCOL_NODES });
  const entry = requireRecord(value, path);
  rejectUnknownKeys(entry, MARKETPLACE_ENTRY_KEYS, path);
  if (entry.format !== "vega-plugin-entry") {
    fail(`${path}.format`, "expected `vega-plugin-entry`");
  }
  if (entry.formatVersion !== 1) fail(`${path}.formatVersion`, "expected version 1");
  requirePluginId(entry.id, `${path}.id`);
  requireNonEmptyString(entry.name, `${path}.name`);
  requireNonEmptyString(entry.version, `${path}.version`);
  if (!Number.isSafeInteger(entry.apiVersion) || Number(entry.apiVersion) < 1) {
    fail(`${path}.apiVersion`, "expected a positive safe integer");
  }
  if (entry.description !== undefined && typeof entry.description !== "string") {
    fail(`${path}.description`, "expected a string");
  }
  if (entry.publisher !== undefined) {
    requireNonEmptyString(entry.publisher, `${path}.publisher`);
  }
  for (const field of ["tags", "capabilities", "permissions"] as const) {
    if (entry[field] !== undefined) assertStringArray(entry[field], `${path}.${field}`);
  }
  if (entry.dependencies !== undefined) {
    assertDependencies(entry.dependencies, `${path}.dependencies`);
  }
  if (entry.optionalDependencies !== undefined) {
    assertDependencies(entry.optionalDependencies, `${path}.optionalDependencies`);
  }
  if (entry.externalRuntimes !== undefined) {
    assertExternalRuntimes(entry.externalRuntimes, `${path}.externalRuntimes`);
  }
  if (entry.targets !== undefined) {
    assertVegaPluginTargets(entry.targets, `${path}.targets`);
  }
  assertVegaPluginInstallSource(entry.source, `${path}.source`);
  if (entry.integrity !== undefined) {
    requireNonEmptyString(entry.integrity, `${path}.integrity`);
  }
}

export function assertVegaPluginCatalog(value: unknown, path = "$"): asserts value is VegaPluginCatalog {
  assertSafeJson(value, path, 0, { nodes: MAX_PROTOCOL_NODES });
  const catalog = requireRecord(value, path);
  rejectUnknownKeys(catalog, CATALOG_KEYS, path);
  if (catalog.format !== "vega-plugin-catalog") {
    fail(`${path}.format`, "expected `vega-plugin-catalog`");
  }
  if (catalog.formatVersion !== 1) {
    fail(`${path}.formatVersion`, "expected version 1");
  }
  requirePluginId(catalog.id, `${path}.id`);
  if (!Array.isArray(catalog.plugins)) {
    fail(`${path}.plugins`, "expected an array");
  }
  const identities = new Set<string>();
  for (const [index, entry] of (catalog.plugins as readonly unknown[]).entries()) {
    const entryPath = `${path}.plugins[${index}]`;
    assertVegaPluginMarketplaceEntry(entry, entryPath);
    const identity = `${entry.id}@${entry.version}`;
    if (identities.has(identity)) {
      fail(entryPath, `duplicate plugin identity ${identity}`);
    }
    identities.add(identity);
  }
}

export function assertVegaPluginLock(value: unknown, path = "$"): asserts value is VegaPluginLock {
  assertSafeJson(value, path, 0, { nodes: MAX_PROTOCOL_NODES });
  const lock = requireRecord(value, path);
  rejectUnknownKeys(lock, LOCK_KEYS, path);
  if (lock.format !== "vega-plugin-lock") {
    fail(`${path}.format`, "expected `vega-plugin-lock`");
  }
  if (lock.formatVersion !== 1) fail(`${path}.formatVersion`, "expected version 1");
  if (lock.projectFormatVersion !== 1) {
    fail(`${path}.projectFormatVersion`, "expected project format version 1");
  }
  if (lock.target !== undefined) assertLockTarget(lock.target, `${path}.target`);
  if (!Array.isArray(lock.plugins)) fail(`${path}.plugins`, "expected an array");

  const entries = lock.plugins as readonly unknown[];
  let previousId = "";
  const versions = new Map<string, string>();
  entries.forEach((entry, index) => {
    const entryPath = `${path}.plugins[${index}]`;
    assertLockEntry(entry, entryPath);
    if (entry.id <= previousId) {
      fail(`${entryPath}.id`, "plugin lock entries must be unique and sorted by id");
    }
    previousId = entry.id;
    versions.set(entry.id, entry.version);
  });

  const graph = new Map<string, readonly string[]>();
  for (const [index, entry] of (entries as readonly VegaPluginLockEntry[]).entries()) {
    const dependencies = Object.entries(entry.dependencies);
    for (const [dependencyId, dependencyVersion] of dependencies) {
      const selectedVersion = versions.get(dependencyId);
      if (selectedVersion === undefined) {
        fail(`${path}.plugins[${index}].dependencies.${dependencyId}`, "dependency is missing from the lock");
      }
      if (selectedVersion !== dependencyVersion) {
        fail(`${path}.plugins[${index}].dependencies.${dependencyId}`, `expected selected version ${selectedVersion}`);
      }
    }
    graph.set(
      entry.id,
      dependencies.map(([id]) => id),
    );
  }
  assertAcyclic(graph, path);
}

export function assertVegaPluginTargets(value: unknown, path = "$"): asserts value is VegaPluginTargets {
  const targets = requireRecord(value, path);
  rejectUnknownKeys(targets, TARGET_KEYS, path);
  for (const field of ["runtimes", "platforms", "architectures"] as const) {
    if (targets[field] !== undefined) {
      assertStringArray(targets[field], `${path}.${field}`);
    }
  }
  if (targets.engineVersion !== undefined) {
    requireNonEmptyString(targets.engineVersion, `${path}.engineVersion`);
  }
  if (targets.apiVersions !== undefined) {
    if (
      !Array.isArray(targets.apiVersions) ||
      targets.apiVersions.some((version) => !Number.isSafeInteger(version) || Number(version) < 1)
    ) {
      fail(`${path}.apiVersions`, "expected an array of positive safe integers");
    }
  }
}

export function assertVegaPluginInstallSource(value: unknown, path = "$"): asserts value is VegaPluginInstallSource {
  const source = requireRecord(value, path);
  switch (source.type) {
    case "registry":
      rejectUnknownKeys(source, new Set(["type", "package", "registry"]), path);
      requireNonEmptyString(source.package, `${path}.package`);
      if (source.registry !== undefined) {
        requireAbsoluteUrl(source.registry, `${path}.registry`);
      }
      return;
    case "url":
      rejectUnknownKeys(source, new Set(["type", "url", "integrity"]), path);
      requireAbsoluteUrl(source.url, `${path}.url`);
      requireNonEmptyString(source.integrity, `${path}.integrity`);
      return;
    case "workspace":
      rejectUnknownKeys(source, new Set(["type", "path"]), path);
      requireNonEmptyString(source.path, `${path}.path`);
      return;
    case "builtin":
      rejectUnknownKeys(source, new Set(["type", "key"]), path);
      requireNonEmptyString(source.key, `${path}.key`);
      return;
    default:
      fail(`${path}.type`, "expected registry, url, workspace, or builtin");
  }
}

function assertLockTarget(value: unknown, path: string): asserts value is VegaPluginLockTarget {
  const target = requireRecord(value, path);
  rejectUnknownKeys(target, LOCK_TARGET_KEYS, path);
  for (const field of ["runtime", "platform", "architecture", "engineVersion"] as const) {
    if (target[field] !== undefined) {
      requireNonEmptyString(target[field], `${path}.${field}`);
    }
  }
  if (target.apiVersion !== undefined && (!Number.isSafeInteger(target.apiVersion) || Number(target.apiVersion) < 1)) {
    fail(`${path}.apiVersion`, "expected a positive safe integer");
  }
}

function assertLockEntry(value: unknown, path: string): asserts value is VegaPluginLockEntry {
  const entry = requireRecord(value, path);
  rejectUnknownKeys(entry, LOCK_ENTRY_KEYS, path);
  requirePluginId(entry.id, `${path}.id`);
  requireNonEmptyString(entry.version, `${path}.version`);
  assertVegaPluginInstallSource(entry.source, `${path}.source`);
  if (entry.integrity !== undefined) {
    requireNonEmptyString(entry.integrity, `${path}.integrity`);
  }
  const dependencies = requireRecord(entry.dependencies, `${path}.dependencies`);
  const dependencyEntries = Object.entries(dependencies);
  const sortedKeys = Object.keys(dependencies).sort(compareJsonObjectKeys);
  if (dependencyEntries.some(([dependency], index) => dependency !== sortedKeys[index])) {
    fail(`${path}.dependencies`, "dependency keys must be sorted by id");
  }
  for (const [dependency, version] of dependencyEntries) {
    requirePluginId(dependency, `${path}.dependencies.${dependency}`);
    requireNonEmptyString(version, `${path}.dependencies.${dependency}`);
  }
  for (const field of ["capabilities", "permissions"] as const) {
    if (entry[field] !== undefined) {
      assertSortedStringArray(entry[field], `${path}.${field}`);
    }
  }
  if (entry.externalRuntimes !== undefined) {
    assertExternalRuntimes(entry.externalRuntimes, `${path}.externalRuntimes`);
  }
}

function assertExternalRuntimes(
  value: unknown,
  path: string,
): asserts value is readonly VegaExternalRuntimeRequirement[] {
  if (!Array.isArray(value)) {
    fail(path, "expected an array");
  }
  const ids = new Set<string>();
  let previousId = "";
  for (const [index, candidate] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    const runtime = requireRecord(candidate, itemPath);
    rejectUnknownKeys(runtime, EXTERNAL_RUNTIME_KEYS, itemPath);
    const id = requirePluginId(runtime.id, `${itemPath}.id`);
    if (id <= previousId || ids.has(id)) {
      fail(`${itemPath}.id`, "external runtime entries must be unique and sorted by id");
    }
    previousId = id;
    ids.add(id);
    requireNonEmptyString(runtime.name, `${itemPath}.name`);
    requireNonEmptyString(runtime.version, `${itemPath}.version`);
    requireNonEmptyString(runtime.license, `${itemPath}.license`);
    if (runtime.homepage !== undefined) {
      requireAbsoluteUrl(runtime.homepage, `${itemPath}.homepage`);
    }
    if (runtime.optional !== undefined && typeof runtime.optional !== "boolean") {
      fail(`${itemPath}.optional`, "expected a boolean");
    }
    if (!Array.isArray(runtime.provisioning) || runtime.provisioning.length === 0) {
      fail(`${itemPath}.provisioning`, "expected at least one provisioning mode");
    }
    const modes = runtime.provisioning as readonly string[];
    if (
      modes.some((mode) => mode !== "host" && mode !== "application-bundle") ||
      new Set(modes).size !== modes.length ||
      [...modes].sort(compareJsonObjectKeys).some((mode, offset) => mode !== modes[offset])
    ) {
      fail(`${itemPath}.provisioning`, "expected unique sorted host/application-bundle modes");
    }
  }
}

function assertDependencies(value: unknown, path: string): void {
  const dependencies = requireRecord(value, path);
  for (const [id, range] of Object.entries(dependencies)) {
    requirePluginId(id, `${path}.${id}`);
    requireNonEmptyString(range, `${path}.${id}`);
  }
}

function assertAcyclic(graph: ReadonlyMap<string, readonly string[]>, path: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].join(" -> ");
      fail(`${path}.plugins`, `dependency cycle: ${cycle}`);
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function parseInput(input: string | Uint8Array | unknown): unknown {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) return input;
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > MAX_PROTOCOL_BYTES) {
    fail("$", `document exceeds ${MAX_PROTOCOL_BYTES} bytes`);
  }
  let source: string;
  try {
    source = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch (error) {
    fail("$", error instanceof Error ? error.message : "invalid UTF-8");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    fail("$", error instanceof Error ? error.message : "invalid JSON");
  }
}

function assertSafeJson(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): asserts value is VegaJsonValue {
  budget.nodes -= 1;
  if (budget.nodes < 0 || depth > MAX_PROTOCOL_DEPTH) {
    fail(path, "JSON structure is too complex");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
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

function assertStringArray(value: unknown, path: string): asserts value is string[] {
  if (!Array.isArray(value)) fail(path, "expected an array of strings");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = requireNonEmptyString(value[index], `${path}[${index}]`);
    if (seen.has(item)) fail(`${path}[${index}]`, "duplicate value");
    seen.add(item);
  }
}

function assertSortedStringArray(value: unknown, path: string): asserts value is string[] {
  assertStringArray(value, path);
  for (let index = 1; index < value.length; index += 1) {
    if (value[index - 1]! >= value[index]!) {
      fail(`${path}[${index}]`, "values must be unique and sorted");
    }
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "expected a plain object");
  }
  return value as Record<string, unknown>;
}

function requirePluginId(value: unknown, path: string): string {
  const id = requireNonEmptyString(value, path);
  if (!PLUGIN_ID_PATTERN.test(id)) fail(path, "invalid plugin id");
  return id;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function requireAbsoluteUrl(value: unknown, path: string): string {
  const source = requireNonEmptyString(value, path);
  try {
    const url = new URL(source);
    if (!url.protocol || url.protocol === "file:") {
      fail(path, "expected a non-file absolute URL");
    }
  } catch (error) {
    if (error instanceof VegaPluginProtocolError) throw error;
    fail(path, "expected an absolute URL");
  }
  return source;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
}

function fail(path: string, message: string): never {
  throw new VegaPluginProtocolError(path, message);
}

const compareJsonObjectKeys = (left: string, right: string): number => {
  const leftIndex = arrayIndex(left);
  const rightIndex = arrayIndex(right);
  if (leftIndex !== null && rightIndex !== null) return leftIndex - rightIndex;
  if (leftIndex !== null) return -1;
  if (rightIndex !== null) return 1;
  return compareStableText(left, right);
};

const arrayIndex = (value: string): number | null => {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < 2 ** 32 - 1 ? index : null;
};

const compareStableText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
