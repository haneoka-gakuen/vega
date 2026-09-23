import {
  assertVegaPluginMarketplaceEntry,
  type VegaPluginInstallSource,
  type VegaPluginLockTarget,
  type VegaPluginMarketplaceEntry,
  type VegaPluginTargets,
} from "@haneoka/vega-protocol";
import { compareVegaSemVer, satisfiesVegaSemVer } from "./semver";

export interface VegaPluginCatalogProvider {
  readonly id: string;
  /**
   * Returns metadata only. Providers do not install, import, download, or
   * execute plugin code.
   */
  entries(): readonly VegaPluginMarketplaceEntry[] | Promise<readonly VegaPluginMarketplaceEntry[]>;
}

export interface VegaPluginCatalogQuery {
  readonly text?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly permissions?: readonly string[];
  readonly target?: VegaPluginLockTarget;
  /** Defaults to false, returning only the newest matching version per id. */
  readonly allVersions?: boolean;
}

export class VegaStaticPluginCatalog implements VegaPluginCatalogProvider {
  readonly id: string;
  private readonly snapshot: readonly VegaPluginMarketplaceEntry[];

  constructor(entries: readonly VegaPluginMarketplaceEntry[], id = "static") {
    this.id = requireCatalogId(id);
    this.snapshot = freezeCatalog(entries);
  }

  entries(): readonly VegaPluginMarketplaceEntry[] {
    return this.snapshot;
  }

  search(query: VegaPluginCatalogQuery = {}): readonly VegaPluginMarketplaceEntry[] {
    return searchVegaPluginCatalog(this.snapshot, query);
  }
}

export class VegaInMemoryPluginRegistry implements VegaPluginCatalogProvider {
  readonly id: string;
  private readonly catalog = new Map<string, VegaPluginMarketplaceEntry>();

  constructor(entries: readonly VegaPluginMarketplaceEntry[] = [], id = "memory") {
    this.id = requireCatalogId(id);
    for (const entry of entries) this.register(entry);
  }

  register(entry: VegaPluginMarketplaceEntry): () => void {
    const snapshot = freezeEntry(entry);
    const key = catalogEntryKey(snapshot);
    this.catalog.set(key, snapshot);
    return () => {
      if (this.catalog.get(key) === snapshot) this.catalog.delete(key);
    };
  }

  remove(id: string, version?: string): number {
    let removed = 0;
    for (const [key, entry] of this.catalog) {
      if (entry.id !== id || (version !== undefined && entry.version !== version)) {
        continue;
      }
      this.catalog.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.catalog.clear();
  }

  entries(): readonly VegaPluginMarketplaceEntry[] {
    return sortCatalogEntries([...this.catalog.values()]);
  }

  search(query: VegaPluginCatalogQuery = {}): readonly VegaPluginMarketplaceEntry[] {
    return searchVegaPluginCatalog(this.entries(), query);
  }
}

export const collectVegaPluginCatalog = async (
  providers: readonly VegaPluginCatalogProvider[],
): Promise<readonly VegaPluginMarketplaceEntry[]> => {
  const collected = (
    await Promise.all(
      [...providers]
        .sort((left, right) => compareStableText(left.id, right.id))
        .map(async (provider) => provider.entries()),
    )
  ).flat();
  return freezeCatalog(collected);
};

export const normalizeVegaPluginCatalog = (
  entries: readonly VegaPluginMarketplaceEntry[],
): readonly VegaPluginMarketplaceEntry[] => freezeCatalog(entries);

export const searchVegaPluginCatalog = (
  entries: readonly VegaPluginMarketplaceEntry[],
  query: VegaPluginCatalogQuery = {},
): readonly VegaPluginMarketplaceEntry[] => {
  const terms = normalizeTerms(query.text);
  const tags = normalizeSet(query.tags);
  const capabilities = normalizeSet(query.capabilities);
  const permissions = normalizeSet(query.permissions);
  const matches = freezeCatalog(entries).filter((entry) => {
    const haystack = [entry.id, entry.name, entry.description ?? "", entry.publisher ?? "", ...(entry.tags ?? [])]
      .join(" ")
      .toLowerCase();
    if (terms.some((term) => !haystack.includes(term))) return false;
    if (!includesAll(entry.tags, tags)) return false;
    if (!includesAll(entry.capabilities, capabilities)) return false;
    if (!includesAll(entry.permissions, permissions)) return false;
    return isVegaPluginTargetCompatible(entry.targets, query.target);
  });
  if (query.allVersions) return matches;
  const latest = new Map<string, VegaPluginMarketplaceEntry>();
  for (const entry of matches) {
    if (!latest.has(entry.id)) latest.set(entry.id, entry);
  }
  return [...latest.values()];
};

export const isVegaPluginTargetCompatible = (
  targets: VegaPluginTargets | undefined,
  target: VegaPluginLockTarget | undefined,
): boolean => {
  if (!targets || !target) return true;
  if (target.runtime && targets.runtimes?.length && !targets.runtimes.includes(target.runtime)) {
    return false;
  }
  if (target.platform && targets.platforms?.length && !targets.platforms.includes(target.platform)) {
    return false;
  }
  if (target.architecture && targets.architectures?.length && !targets.architectures.includes(target.architecture)) {
    return false;
  }
  if (
    target.apiVersion !== undefined &&
    targets.apiVersions?.length &&
    !targets.apiVersions.includes(target.apiVersion)
  ) {
    return false;
  }
  if (
    target.engineVersion &&
    targets.engineVersion &&
    !satisfiesVegaSemVer(target.engineVersion, targets.engineVersion)
  ) {
    return false;
  }
  return true;
};

export const vegaPluginSourceKey = (source: VegaPluginInstallSource): string => {
  switch (source.type) {
    case "registry":
      return `registry:${source.registry ?? ""}:${source.package}`;
    case "url":
      return `url:${source.url}:${source.integrity}`;
    case "workspace":
      return `workspace:${source.path}`;
    case "builtin":
      return `builtin:${source.key}`;
  }
};

const freezeCatalog = (entries: readonly VegaPluginMarketplaceEntry[]): readonly VegaPluginMarketplaceEntry[] => {
  const unique = new Map<string, VegaPluginMarketplaceEntry>();
  for (const candidate of entries) {
    const entry = freezeEntry(candidate);
    const key = catalogEntryKey(entry);
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(`Conflicting Vega plugin catalog metadata for ${entry.id}@${entry.version}`);
    }
    unique.set(key, existing ?? entry);
  }
  return Object.freeze(sortCatalogEntries([...unique.values()]));
};

const freezeEntry = (candidate: VegaPluginMarketplaceEntry): VegaPluginMarketplaceEntry => {
  assertVegaPluginMarketplaceEntry(candidate);
  const clone: VegaPluginMarketplaceEntry = {
    format: "vega-plugin-entry",
    formatVersion: 1,
    id: candidate.id,
    name: candidate.name,
    version: candidate.version,
    apiVersion: 1,
    ...(candidate.description !== undefined ? { description: candidate.description } : {}),
    ...(candidate.publisher !== undefined ? { publisher: candidate.publisher } : {}),
    ...(candidate.tags ? { tags: sortedUnique(candidate.tags) } : {}),
    ...(candidate.capabilities ? { capabilities: sortedUnique(candidate.capabilities) } : {}),
    ...(candidate.permissions ? { permissions: sortedUnique(candidate.permissions) } : {}),
    ...(candidate.dependencies ? { dependencies: sortedRecord(candidate.dependencies) } : {}),
    ...(candidate.optionalDependencies ? { optionalDependencies: sortedRecord(candidate.optionalDependencies) } : {}),
    ...(candidate.externalRuntimes?.length
      ? {
          externalRuntimes: Object.freeze(
            [...candidate.externalRuntimes]
              .sort((left, right) => compareStableText(left.id, right.id))
              .map((runtime) =>
                Object.freeze({
                  id: runtime.id,
                  name: runtime.name,
                  version: runtime.version,
                  license: runtime.license,
                  ...(runtime.homepage !== undefined ? { homepage: runtime.homepage } : {}),
                  ...(runtime.optional !== undefined ? { optional: runtime.optional } : {}),
                  provisioning: Object.freeze([...new Set(runtime.provisioning)].sort(compareStableText)),
                }),
              ),
          ),
        }
      : {}),
    ...(candidate.targets ? { targets: freezeTargets(candidate.targets) } : {}),
    source: freezeSource(candidate.source),
    ...(candidate.integrity !== undefined ? { integrity: candidate.integrity } : {}),
  };
  return Object.freeze(clone);
};

const freezeTargets = (targets: VegaPluginTargets): VegaPluginTargets =>
  Object.freeze({
    ...(targets.runtimes ? { runtimes: sortedUnique(targets.runtimes) } : {}),
    ...(targets.platforms ? { platforms: sortedUnique(targets.platforms) } : {}),
    ...(targets.architectures ? { architectures: sortedUnique(targets.architectures) } : {}),
    ...(targets.engineVersion !== undefined ? { engineVersion: targets.engineVersion } : {}),
    ...(targets.apiVersions
      ? {
          apiVersions: Object.freeze([...new Set(targets.apiVersions)].sort((left, right) => left - right)),
        }
      : {}),
  });

const freezeSource = (source: VegaPluginInstallSource): VegaPluginInstallSource => {
  switch (source.type) {
    case "registry":
      return Object.freeze({
        type: "registry",
        package: source.package,
        ...(source.registry !== undefined ? { registry: source.registry } : {}),
      });
    case "url":
      return Object.freeze({
        type: "url",
        url: source.url,
        integrity: source.integrity,
      });
    case "workspace":
      return Object.freeze({ type: "workspace", path: source.path });
    case "builtin":
      return Object.freeze({ type: "builtin", key: source.key });
  }
};

const sortCatalogEntries = (entries: VegaPluginMarketplaceEntry[]): VegaPluginMarketplaceEntry[] =>
  entries.sort((left, right) => {
    const id = compareStableText(left.id, right.id);
    if (id) return id;
    let version = 0;
    try {
      version = compareVegaSemVer(right.version, left.version);
    } catch {
      version = compareStableText(right.version, left.version);
    }
    return version || compareStableText(vegaPluginSourceKey(left.source), vegaPluginSourceKey(right.source));
  });

const catalogEntryKey = (entry: VegaPluginMarketplaceEntry): string =>
  `${entry.id}\0${entry.version}\0${vegaPluginSourceKey(entry.source)}`;

const sortedUnique = (values: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(values)].sort(compareStableText));

const sortedRecord = (record: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.freeze(Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareStableText(left, right))));

const normalizeTerms = (value: string | undefined): readonly string[] =>
  (value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);

const normalizeSet = (values: readonly string[] | undefined): ReadonlySet<string> =>
  new Set((values ?? []).map((value) => value.trim()).filter(Boolean));

const includesAll = (values: readonly string[] | undefined, expected: ReadonlySet<string>): boolean => {
  if (!expected.size) return true;
  const available = new Set(values ?? []);
  return [...expected].every((value) => available.has(value));
};

const requireCatalogId = (id: string): string => {
  if (!id.trim()) throw new TypeError("Vega plugin catalog provider requires an id");
  return id;
};

const compareStableText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
