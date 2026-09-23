import type { VegaJsonValue } from "@haneoka/vega-protocol";
import type { VegaPlugin } from "./plugins";

const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_MODULE_BYTES = 64 * 1024 * 1024;
const MAX_EXTERNAL_RUNTIME_FILE_BYTES = 512 * 1024 * 1024;
const SHA256_INTEGRITY = /^sha256-([0-9a-f]{64})$/u;
const RUNTIME_INDEX_KEYS = new Set(["format", "formatVersion", "plugins"]);
const RUNTIME_PLUGIN_KEYS = new Set([
  "id",
  "version",
  "integrity",
  "dependencies",
  "permissions",
  "configuration",
  "artifactKind",
  "artifact",
]);
const EXTERNAL_INDEX_KEYS = new Set([
  "format",
  "formatVersion",
  "applicationId",
  "publiclyRedistributable",
  "externalRuntimes",
]);
const EXTERNAL_RUNTIME_KEYS = new Set([
  "id",
  "name",
  "version",
  "license",
  "homepage",
  "requiredBy",
  "optional",
  "status",
  "artifactRoot",
  "files",
  "authorization",
]);
const EXTERNAL_FILE_KEYS = new Set(["path", "integrity", "bytes"]);
const EXTERNAL_AUTHORIZATION_KEYS = new Set([
  "distribution",
  "applicationId",
  "license",
  "acknowledgement",
  "receiptIntegrity",
]);
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface DenebExternalRuntimeFile {
  readonly path: string;
  readonly integrity: string;
  readonly bytes: number;
  readonly url: URL;
}

export interface DenebExternalRuntimeBinding {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly homepage?: string;
  readonly requiredBy: readonly string[];
  readonly optional: boolean;
  readonly status: "application-bundle" | "host";
  readonly files: readonly DenebExternalRuntimeFile[];
}

export interface DenebExternalRuntimeAccess {
  readonly applicationId: string;
  readonly publiclyRedistributable: boolean;
  readonly runtimes: readonly DenebExternalRuntimeBinding[];
  get(id: string): DenebExternalRuntimeBinding | undefined;
  fetch(runtimeId: string, path: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
}

export interface DenebRuntimePluginFactoryContext {
  readonly id: string;
  readonly version: string;
  readonly configuration: VegaJsonValue;
  readonly permissions: readonly string[];
  readonly externalRuntimes?: DenebExternalRuntimeAccess;
  readonly signal: AbortSignal;
}

export interface DenebRuntimePluginModule {
  readonly default?: VegaPlugin;
  readonly vegaPlugin?: VegaPlugin;
  readonly createVegaPlugin?: (context: DenebRuntimePluginFactoryContext) => VegaPlugin | Promise<VegaPlugin>;
}

export interface DenebRuntimePluginLoadOptions {
  readonly runtimePluginIndexUrl?: string | URL;
  readonly externalRuntimeIndexUrl?: string | URL;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Test/host seam. Browser builds use an integrity-checked Blob URL. */
  readonly importModule?: (url: string) => Promise<unknown>;
  readonly createObjectUrl?: (blob: Blob) => string;
  readonly revokeObjectUrl?: (url: string) => void;
}

export interface LoadedDenebRuntimePlugins {
  readonly plugins: readonly VegaPlugin[];
  readonly externalRuntimes?: DenebExternalRuntimeAccess;
}

interface RuntimePluginIndex {
  readonly format: "vega-runtime-plugin-bundle";
  readonly formatVersion: 1;
  readonly plugins: readonly RuntimePluginIndexEntry[];
}

interface RuntimePluginIndexEntry {
  readonly id: string;
  readonly version: string;
  readonly integrity: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly permissions: readonly string[];
  readonly configuration: VegaJsonValue;
  readonly artifactKind: "module" | "wasm-component" | "package";
  readonly artifact: string;
}

interface ExternalRuntimeIndex {
  readonly format: "deneb-external-runtime-bundle";
  readonly formatVersion: 1;
  readonly applicationId: string;
  readonly publiclyRedistributable: boolean;
  readonly externalRuntimes: readonly ExternalRuntimeIndexEntry[];
}

interface ExternalRuntimeIndexEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly homepage?: string;
  readonly requiredBy: readonly string[];
  readonly optional: boolean;
  readonly status: "application-bundle" | "host";
  readonly artifactRoot?: string;
  readonly files?: readonly {
    readonly path: string;
    readonly integrity: string;
    readonly bytes: number;
  }[];
  readonly authorization?: {
    readonly distribution: "application-private";
    readonly applicationId: string;
    readonly license: string;
    readonly acknowledgement: "accepted-for-application-private-build";
    readonly receiptIntegrity: string;
  };
}

/**
 * Loads only Deneb-verified ESM artifacts. Every module is re-hashed in the
 * browser before evaluation and is installed by Vega with third-party
 * authority. WASM components and opaque packages require a host adapter.
 */
export const loadDenebRuntimePlugins = async (
  options: DenebRuntimePluginLoadOptions,
): Promise<LoadedDenebRuntimePlugins> => {
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new ReferenceError("Deneb runtime plugin loading requires fetch");
  }
  const externalRuntimes = options.externalRuntimeIndexUrl
    ? await loadExternalRuntimeAccess(new URL(String(options.externalRuntimeIndexUrl), documentBase()), fetcher, signal)
    : undefined;
  if (!options.runtimePluginIndexUrl) {
    return Object.freeze({
      plugins: Object.freeze([]),
      ...(externalRuntimes ? { externalRuntimes } : {}),
    });
  }

  const indexUrl = new URL(String(options.runtimePluginIndexUrl), documentBase());
  const index = parseRuntimePluginIndex(await fetchJson(indexUrl, fetcher, signal));
  validateDependencyOrder(index.plugins);
  const plugins: VegaPlugin[] = [];
  for (const entry of index.plugins) {
    throwIfAborted(signal);
    if (entry.artifactKind !== "module") {
      throw new TypeError(
        `Deneb runtime plugin ${entry.id}@${entry.version} uses ${entry.artifactKind}; a browser host adapter is required`,
      );
    }
    const artifactUrl = safeRelativeUrl(entry.artifact, indexUrl);
    const bytes = await fetchBytes(artifactUrl, fetcher, signal, MAX_MODULE_BYTES);
    await verifyIntegrity(bytes, entry.integrity);
    const module = await importVerifiedModule(bytes, options);
    const plugin = await materializePlugin(module, {
      id: entry.id,
      version: entry.version,
      configuration: cloneJson(entry.configuration),
      permissions: Object.freeze([...entry.permissions]),
      ...(externalRuntimes ? { externalRuntimes } : {}),
      signal,
    });
    if (plugin.manifest.id !== entry.id || plugin.manifest.version !== entry.version) {
      throw new TypeError(
        `Deneb runtime plugin artifact declared ${plugin.manifest.id}@${plugin.manifest.version}, expected ${entry.id}@${entry.version}`,
      );
    }
    plugins.push(plugin);
  }
  return Object.freeze({
    plugins: Object.freeze(plugins),
    ...(externalRuntimes ? { externalRuntimes } : {}),
  });
};

const importVerifiedModule = async (bytes: Uint8Array, options: DenebRuntimePluginLoadOptions): Promise<unknown> => {
  const createObjectUrl = options.createObjectUrl ?? globalThis.URL?.createObjectURL?.bind(URL);
  const revokeObjectUrl = options.revokeObjectUrl ?? globalThis.URL?.revokeObjectURL?.bind(URL);
  if (!createObjectUrl || !revokeObjectUrl) {
    throw new ReferenceError("Deneb runtime plugin loading requires Blob URL support");
  }
  const url = createObjectUrl(
    new Blob([bytes.slice().buffer], {
      type: "text/javascript;charset=utf-8",
    }),
  );
  try {
    const importer = options.importModule ?? ((specifier: string) => import(/* @vite-ignore */ specifier));
    return await importer(url);
  } finally {
    revokeObjectUrl(url);
  }
};

const materializePlugin = async (value: unknown, context: DenebRuntimePluginFactoryContext): Promise<VegaPlugin> => {
  if (!record(value)) {
    throw new TypeError(`Deneb runtime plugin ${context.id} has no ESM exports`);
  }
  const module = value as DenebRuntimePluginModule;
  const plugin =
    typeof module.createVegaPlugin === "function"
      ? await module.createVegaPlugin(Object.freeze(context))
      : (module.vegaPlugin ?? module.default);
  if (!plugin || typeof plugin !== "object" || typeof plugin.setup !== "function" || !record(plugin.manifest)) {
    throw new TypeError(`Deneb runtime plugin ${context.id} did not export a Vega plugin`);
  }
  return plugin;
};

const loadExternalRuntimeAccess = async (
  indexUrl: URL,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<DenebExternalRuntimeAccess> => {
  const index = parseExternalRuntimeIndex(await fetchJson(indexUrl, fetcher, signal));
  const runtimes = Object.freeze(
    index.externalRuntimes.map((entry) => {
      const root =
        entry.status === "application-bundle"
          ? safeRelativeUrl(requireString(entry.artifactRoot, "artifactRoot"), indexUrl, true)
          : undefined;
      const files = Object.freeze(
        (entry.files ?? []).map((file) =>
          Object.freeze({
            path: file.path,
            integrity: file.integrity,
            bytes: file.bytes,
            url: safeRelativeUrl(file.path, root!),
          }),
        ),
      );
      return Object.freeze({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        license: entry.license,
        ...(entry.homepage ? { homepage: entry.homepage } : {}),
        requiredBy: Object.freeze([...entry.requiredBy]),
        optional: entry.optional,
        status: entry.status,
        files,
      });
    }),
  );
  const byId = new Map(runtimes.map((entry) => [entry.id, entry]));
  return Object.freeze({
    applicationId: index.applicationId,
    publiclyRedistributable: index.publiclyRedistributable,
    runtimes,
    get: (id: string) => byId.get(id),
    fetch: async (runtimeId: string, path: string, fetchOptions: { readonly signal?: AbortSignal } = {}) => {
      const runtime = byId.get(runtimeId);
      if (!runtime) {
        throw new RangeError(`Unknown external runtime: ${runtimeId}`);
      }
      const file = runtime.files.find((candidate) => candidate.path === path);
      if (!file) {
        throw new RangeError(`External runtime ${runtimeId} does not declare ${path}`);
      }
      const linked = linkSignals(signal, fetchOptions.signal);
      try {
        const bytes = await fetchBytes(
          file.url,
          fetcher,
          linked.signal,
          Math.min(MAX_EXTERNAL_RUNTIME_FILE_BYTES, file.bytes),
        );
        if (bytes.byteLength !== file.bytes) {
          throw new TypeError(`External runtime ${runtimeId}/${path} size changed after packaging`);
        }
        await verifyIntegrity(bytes, file.integrity);
        return bytes;
      } finally {
        linked.dispose();
      }
    },
  });
};

const parseRuntimePluginIndex = (value: unknown): RuntimePluginIndex => {
  const root = requireRecord(value, "runtime plugin index");
  rejectUnknownKeys(root, RUNTIME_INDEX_KEYS, "runtime plugin index");
  if (root.format !== "vega-runtime-plugin-bundle" || root.formatVersion !== 1 || !Array.isArray(root.plugins)) {
    throw new TypeError("Unsupported Deneb runtime plugin index");
  }
  const plugins = root.plugins.map((candidate, index) => {
    const entry = requireRecord(candidate, `plugins[${index}]`);
    rejectUnknownKeys(entry, RUNTIME_PLUGIN_KEYS, `plugins[${index}]`);
    const artifactKind = entry.artifactKind;
    if (artifactKind !== "module" && artifactKind !== "wasm-component" && artifactKind !== "package") {
      throw new TypeError(`plugins[${index}].artifactKind is invalid`);
    }
    const dependencies = requireStringRecord(entry.dependencies, `plugins[${index}].dependencies`);
    return Object.freeze({
      id: requireId(entry.id, `plugins[${index}].id`),
      version: requireString(entry.version, `plugins[${index}].version`),
      integrity: requireIntegrity(entry.integrity, `plugins[${index}].integrity`),
      dependencies,
      permissions: requireStringArray(entry.permissions, `plugins[${index}].permissions`),
      configuration: requireJson(entry.configuration ?? null, `plugins[${index}].configuration`),
      artifactKind,
      artifact: requirePortablePath(entry.artifact, `plugins[${index}].artifact`),
    });
  });
  return Object.freeze({
    format: "vega-runtime-plugin-bundle",
    formatVersion: 1,
    plugins: Object.freeze(plugins),
  });
};

const parseExternalRuntimeIndex = (value: unknown): ExternalRuntimeIndex => {
  const root = requireRecord(value, "external runtime index");
  rejectUnknownKeys(root, EXTERNAL_INDEX_KEYS, "external runtime index");
  if (
    root.format !== "deneb-external-runtime-bundle" ||
    root.formatVersion !== 1 ||
    !Array.isArray(root.externalRuntimes)
  ) {
    throw new TypeError("Unsupported Deneb external runtime index");
  }
  const applicationId = requireString(root.applicationId, "applicationId");
  const publiclyRedistributable = requireBoolean(root.publiclyRedistributable, "publiclyRedistributable");
  const seenIds = new Set<string>();
  const entries = root.externalRuntimes.map((candidate, index) => {
    const entry = requireRecord(candidate, `externalRuntimes[${index}]`);
    rejectUnknownKeys(entry, EXTERNAL_RUNTIME_KEYS, `externalRuntimes[${index}]`);
    if (entry.status !== "application-bundle" && entry.status !== "host") {
      throw new TypeError(`externalRuntimes[${index}].status is invalid`);
    }
    let previousFile = "";
    const files = requireArray(entry.files ?? [], `externalRuntimes[${index}].files`).map((candidate, fileIndex) => {
      const file = requireRecord(candidate, `externalRuntimes[${index}].files[${fileIndex}]`);
      rejectUnknownKeys(file, EXTERNAL_FILE_KEYS, `externalRuntimes[${index}].files[${fileIndex}]`);
      const bytes = file.bytes;
      if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) {
        throw new TypeError(`externalRuntimes[${index}].files[${fileIndex}].bytes is invalid`);
      }
      const filePath = requirePortablePath(file.path, `externalRuntimes[${index}].files[${fileIndex}].path`);
      if (filePath <= previousFile) {
        throw new TypeError(`externalRuntimes[${index}].files must be unique and sorted`);
      }
      previousFile = filePath;
      return Object.freeze({
        path: filePath,
        integrity: requireIntegrity(file.integrity, `externalRuntimes[${index}].files[${fileIndex}].integrity`),
        bytes: Number(bytes),
      });
    });
    if (
      entry.status === "application-bundle" &&
      (!entry.artifactRoot || !files.length || !record(entry.authorization))
    ) {
      throw new TypeError(`externalRuntimes[${index}] has no application-private artifact`);
    }
    if (entry.status === "application-bundle") {
      const authorization = entry.authorization as Record<string, unknown>;
      rejectUnknownKeys(authorization, EXTERNAL_AUTHORIZATION_KEYS, `externalRuntimes[${index}].authorization`);
      if (
        authorization.distribution !== "application-private" ||
        authorization.applicationId !== applicationId ||
        authorization.license !== entry.license ||
        authorization.acknowledgement !== "accepted-for-application-private-build"
      ) {
        throw new TypeError(`externalRuntimes[${index}] authorization does not match this application and license`);
      }
      requireIntegrity(authorization.receiptIntegrity, `externalRuntimes[${index}].authorization.receiptIntegrity`);
    }
    if (
      entry.status === "host" &&
      (entry.artifactRoot !== undefined || files.length || entry.authorization !== undefined)
    ) {
      throw new TypeError(`externalRuntimes[${index}] host requirement contains bundled bytes`);
    }
    const id = requireId(entry.id, `externalRuntimes[${index}].id`);
    if (seenIds.has(id)) {
      throw new TypeError(`Duplicate external runtime ${id}`);
    }
    seenIds.add(id);
    return Object.freeze({
      id,
      name: requireString(entry.name, `externalRuntimes[${index}].name`),
      version: requireString(entry.version, `externalRuntimes[${index}].version`),
      license: requireString(entry.license, `externalRuntimes[${index}].license`),
      ...(entry.homepage === undefined
        ? {}
        : {
            homepage: requireHttpsUrl(entry.homepage, `externalRuntimes[${index}].homepage`),
          }),
      requiredBy: requireStringArray(entry.requiredBy, `externalRuntimes[${index}].requiredBy`),
      optional: entry.optional === true,
      status: entry.status,
      ...(entry.artifactRoot === undefined
        ? {}
        : {
            artifactRoot: requirePortablePath(entry.artifactRoot, `externalRuntimes[${index}].artifactRoot`, true),
          }),
      files: Object.freeze(files),
    });
  });
  if (publiclyRedistributable === entries.some(({ status }) => status === "application-bundle")) {
    throw new TypeError("External runtime redistribution flag contradicts bundled private files");
  }
  return Object.freeze({
    format: "deneb-external-runtime-bundle",
    formatVersion: 1,
    applicationId,
    publiclyRedistributable,
    externalRuntimes: Object.freeze(entries),
  });
};

const validateDependencyOrder = (plugins: readonly RuntimePluginIndexEntry[]): void => {
  const seen = new Map<string, string>();
  for (const entry of plugins) {
    if (seen.has(entry.id)) {
      throw new TypeError(`Duplicate Deneb runtime plugin ${entry.id}`);
    }
    for (const [dependency, version] of Object.entries(entry.dependencies)) {
      if (seen.get(dependency) !== version) {
        throw new TypeError(
          `Deneb runtime plugin ${entry.id} dependency ${dependency}@${version} is absent or out of order`,
        );
      }
    }
    seen.set(entry.id, entry.version);
  }
};

const fetchJson = async (url: URL, fetcher: typeof fetch, signal: AbortSignal): Promise<unknown> => {
  const bytes = await fetchBytes(url, fetcher, signal, MAX_INDEX_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new TypeError(
      `Deneb index ${url} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const fetchBytes = async (
  url: URL,
  fetcher: typeof fetch,
  signal: AbortSignal,
  maximum: number,
): Promise<Uint8Array> => {
  throwIfAborted(signal);
  const response = await fetcher(url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`Deneb artifact request failed (${response.status}): ${url}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RangeError(`Deneb artifact exceeds ${maximum} bytes: ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) {
    throw new RangeError(`Deneb artifact exceeds ${maximum} bytes: ${url}`);
  }
  return bytes;
};

const verifyIntegrity = async (bytes: Uint8Array, integrity: string): Promise<void> => {
  const expected = requireIntegrity(integrity, "integrity").slice(7);
  if (!globalThis.crypto?.subtle) {
    throw new ReferenceError("Deneb runtime plugin verification requires Web Crypto");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  const actual = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) {
    throw new TypeError("Deneb runtime artifact integrity mismatch");
  }
};

const safeRelativeUrl = (value: string, base: URL, directory = false): URL => {
  const relative = requirePortablePath(value, "artifact URL", directory);
  const resolved = new URL(relative, base);
  if (resolved.origin !== base.origin) {
    throw new TypeError("Deneb artifact URL changes origin");
  }
  return resolved;
};

const requirePortablePath = (value: unknown, path: string, directory = false): string => {
  const candidate = requireString(value, path).replace(/\\/gu, "/");
  const trimmed = candidate.replace(/^\.\//u, "");
  const parts = trimmed.split("/");
  if (directory && parts.at(-1) === "") parts.pop();
  if (
    candidate.startsWith("/") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new TypeError(`${path} must be a portable relative path`);
  }
  return directory && !candidate.endsWith("/") ? `${candidate}/` : candidate;
};

const requireRecord = (value: unknown, path: string): Record<string, unknown> => {
  if (!record(value)) throw new TypeError(`${path} must be an object`);
  return value;
};

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new TypeError(`${path} contains unknown field ${unknown[0]}`);
  }
};

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireArray = (value: unknown, path: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
};

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
};

const requireBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean`);
  }
  return value;
};

const requireJson = (value: unknown, path: string): VegaJsonValue => {
  const visit = (candidate: unknown, currentPath: string, depth: number): candidate is VegaJsonValue => {
    if (depth > 64) return false;
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return true;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate);
    if (Array.isArray(candidate)) {
      return candidate.every((entry, index) => visit(entry, `${currentPath}[${index}]`, depth + 1));
    }
    if (!record(candidate)) return false;
    return Object.entries(candidate).every(
      ([key, entry]) =>
        Boolean(key) && !DANGEROUS_JSON_KEYS.has(key) && visit(entry, `${currentPath}.${key}`, depth + 1),
    );
  };
  if (!visit(value, path, 0)) {
    throw new TypeError(`${path} must be finite JSON data`);
  }
  return cloneJson(value);
};

const requireId = (value: unknown, path: string): string => {
  const id = requireString(value, path);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(id)) {
    throw new TypeError(`${path} is not a portable id`);
  }
  return id;
};

const requireIntegrity = (value: unknown, path: string): string => {
  const integrity = requireString(value, path);
  if (!SHA256_INTEGRITY.test(integrity)) {
    throw new TypeError(`${path} must be lowercase SHA-256 integrity`);
  }
  return integrity;
};

const requireStringArray = (value: unknown, path: string): readonly string[] => {
  const array = requireArray(value ?? [], path).map((entry, index) => requireString(entry, `${path}[${index}]`));
  if (new Set(array).size !== array.length) {
    throw new TypeError(`${path} must not contain duplicates`);
  }
  return Object.freeze(array);
};

const requireStringRecord = (value: unknown, path: string): Readonly<Record<string, string>> => {
  const source = requireRecord(value ?? {}, path);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).map(([key, entry]) => [
        requireId(key, `${path}.${key}`),
        requireString(entry, `${path}.${key}`),
      ]),
    ),
  );
};

const requireHttpsUrl = (value: unknown, path: string): string => {
  const source = requireString(value, path);
  const url = new URL(source);
  if (url.protocol !== "https:") {
    throw new TypeError(`${path} must use HTTPS`);
  }
  return url.href;
};

const cloneJson = <T extends VegaJsonValue>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const documentBase = (): string => globalThis.document?.baseURI ?? "http://localhost/";

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
};

const linkSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const abort = (event: Event) => {
    const source = event.target as AbortSignal;
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const signal of available) {
    if (signal.aborted && !controller.signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of available) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
};
