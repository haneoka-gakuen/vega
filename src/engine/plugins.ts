import {
  isVegaOfficialExtensionOpcode,
  isVegaThirdPartyOpcode,
  VEGA_OFFICIAL_EXTENSION_RANGE,
  VEGA_THIRD_PARTY_OPCODE_MINIMUM,
} from "@haneoka/vega-protocol";
import type { AdvCommandExecutor } from "../core/AdvCommandService";
import type { AdvPlayer } from "../core/AdvPlayer";
import type {
  StorySceneBackend,
  StorySceneBackendContext,
} from "../rendering/StorySceneBackend";
import type { StoryCharacterProvider } from "../rendering/StoryCharacterModel";
import type {
  StoryRendererEffectContribution,
  StoryRendererServiceKey,
} from "../rendering/StoryRendererExtensions";
import type { AdvPlayerState } from "../types/AdvRuntime";
import { VegaEventBus, type VegaEventMap } from "./events";
import { VegaLifetime, type VegaDisposable } from "./lifecycle";

export type { VegaDisposable } from "./lifecycle";

export const VEGA_PLUGIN_API_VERSION = 1;
export const VEGA_FIRST_EXTENSION_OPCODE = VEGA_OFFICIAL_EXTENSION_RANGE.minimum;
export const VEGA_LAST_OFFICIAL_EXTENSION_OPCODE = VEGA_OFFICIAL_EXTENSION_RANGE.maximum;
export const VEGA_FIRST_THIRD_PARTY_OPCODE = VEGA_THIRD_PARTY_OPCODE_MINIMUM;
/** Standard singleton selection group for equivalent host-input adapters. */
export const VEGA_INPUT_PORT = "vega.engine.input";
/** Default singleton port consumed by `VegaEngine.storage`. */
export const VEGA_STORAGE_PORT = "vega.engine.storage";

export type VegaPluginAuthority = "official" | "third-party";

export interface VegaPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly description?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly capabilities?: readonly VegaPluginCapability[];
}

export type VegaPluginCapability =
  | "commands"
  | "rich-text"
  | "theme"
  | "ui-slot"
  | "render"
  | "character"
  | "effect"
  | "resource"
  | "audio"
  | "input"
  | "storage"
  | "diagnostics";

export interface VegaCommandExtension {
  readonly opcode: number;
  readonly name: string;
  readonly execute: AdvCommandExecutor;
  readonly replaySafe?: boolean;
}

export interface VegaRegisteredCommandExtension extends VegaCommandExtension {
  readonly owner: string;
  readonly authority: VegaPluginAuthority;
}

export interface VegaContribution {
  readonly id: string;
  readonly name?: string;
}

export interface VegaContributionOptions {
  /** Higher values win a singleton or override selection. Defaults to 0. */
  readonly priority?: number;
  /**
   * Contribution id, or `plugin-id:contribution-id`, to replace. Overrides
   * create a deterministic selection group without allowing duplicate ids.
   */
  readonly override?: string | readonly string[];
  /** At most one contribution is active for a named port within this kind. */
  readonly singletonPort?: string;
}

export interface VegaContributionSelection<T extends VegaContribution = VegaContribution> {
  readonly owner: string;
  readonly kind: keyof VegaContributionMap;
  readonly contribution: T;
  readonly priority: number;
  readonly overrides: readonly string[];
  readonly singletonPort?: string;
  readonly active: boolean;
  readonly suppressedBy?: string;
}

export interface VegaThemeContribution extends VegaContribution {
  /** Select this contribution when a player does not request a theme id. */
  readonly default?: boolean;
  readonly tokens?: Readonly<Record<string, string | number>>;
  /** Original plugin CSS scoped by the author to their theme selector. */
  readonly cssText?: string;
}

export interface VegaUiSlotContext {
  readonly engineId: string;
  readonly playerId: string;
  readonly player: AdvPlayer;
  readonly state: AdvPlayerState;
  readonly root: HTMLElement;
  readonly signal: AbortSignal;
  readonly services: <T>(key: VegaServiceKey<T>) => T | undefined;
}

export interface VegaUiSlotContribution extends VegaContribution {
  readonly slot: "before-stage" | "stage-overlay" | "dialogue" | "controls" | "after-stage" | (string & {});
  /**
   * Replace contributions registered earlier for the same slot.
   *
   * This lets a theme or platform surface override a portable fallback
   * without mounting two interactive layers or coupling either plugin to the
   * other's implementation id. Contributions registered after the replacing
   * one may still augment the slot deliberately.
   */
  readonly replace?: boolean;
  /**
   * Player-scoped services that must exist before this surface is mounted.
   * Services are requested explicitly so installing an unrelated UI plugin
   * never enables shell or persistence facilities as a side effect.
   */
  readonly requiredServices?: readonly VegaServiceKey<unknown>[];
  mount(host: HTMLElement, context: VegaUiSlotContext): VegaDisposable | Promise<VegaDisposable>;
}

export interface VegaRenderContribution extends VegaContribution {
  /** Stable backend selector exposed through `VegaPlayerOptions.renderBackend`. */
  readonly backend: string;
  create(
    context: StorySceneBackendContext,
    signal: AbortSignal,
  ): StorySceneBackend | Promise<StorySceneBackend>;
}

/**
 * A host-owned model-format adapter. Vega never imports the adapter's SDK or
 * redistributes its model assets.
 */
export interface VegaCharacterContribution
  extends VegaContribution,
    StoryCharacterProvider {}

export interface VegaEffectContribution
  extends VegaContribution,
    StoryRendererEffectContribution {}

export interface VegaResourceContribution extends VegaContribution {
  /** URL schemes handled by this adapter, without the trailing colon. */
  readonly schemes: readonly string[];
  load(url: URL, signal: AbortSignal): Promise<Uint8Array>;
}

export type VegaAudioInstance = VegaDisposable & {
  play(): void | Promise<void>;
  pause(): void;
  stop(): void;
  readonly currentTime?: number;
};

export interface VegaAudioContribution extends VegaContribution {
  readonly mediaTypes?: readonly string[];
  create(source: string | URL, signal: AbortSignal): VegaAudioInstance | Promise<VegaAudioInstance>;
}

export interface VegaInputEvent {
  readonly action: string;
  readonly value?: number | string | boolean;
  readonly source?: string;
}

export interface VegaInputContribution extends VegaContribution {
  subscribe(listener: (event: VegaInputEvent) => void, signal: AbortSignal): VegaDisposable;
}

export interface VegaStorageContribution extends VegaContribution {
  get(key: string, signal?: AbortSignal): Promise<unknown>;
  set(key: string, value: unknown, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export interface VegaContributionMap {
  readonly theme: VegaThemeContribution;
  readonly "ui-slot": VegaUiSlotContribution;
  readonly render: VegaRenderContribution;
  readonly character: VegaCharacterContribution;
  readonly effect: VegaEffectContribution;
  readonly resource: VegaResourceContribution;
  readonly audio: VegaAudioContribution;
  readonly input: VegaInputContribution;
  readonly storage: VegaStorageContribution;
}

export interface VegaPluginContext {
  readonly lifetime: VegaLifetime;
  readonly events: VegaEventBus<VegaEventMap>;
  registerCommand(extension: VegaCommandExtension): () => void;
  contribute<K extends keyof VegaContributionMap>(
    kind: K,
    contribution: VegaContributionMap[K],
    options?: VegaContributionOptions,
  ): () => void;
  provide<T>(key: VegaServiceKey<T>, value: T): () => void;
  service<T>(key: VegaServiceKey<T>): T | undefined;
}

export interface VegaPlugin {
  readonly manifest: VegaPluginManifest;
  setup(context: VegaPluginContext): void | VegaPluginActivation | Promise<void | VegaPluginActivation>;
}

export interface VegaPluginActivation {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export interface VegaServiceKey<T> extends StoryRendererServiceKey<T> {}

export const defineVegaService = <T>(id: string): VegaServiceKey<T> => Object.freeze({ id });
export const defineVegaPlugin = <T extends VegaPlugin>(plugin: T): T => plugin;

interface InstalledPlugin {
  readonly plugin: VegaPlugin;
  readonly manifest: VegaPluginManifest;
  readonly lifetime: VegaLifetime;
  readonly authority: VegaPluginAuthority;
  readonly activation?: VegaPluginActivation;
}

type RegisteredContribution<T extends VegaContribution> = {
  readonly owner: string;
  readonly value: T;
  readonly priority: number;
  readonly overrides: readonly string[];
  readonly singletonPort?: string;
};

/**
 * Owns plugin activation and all registrations made through a plugin context.
 *
 * Mutations are serialized so concurrent `install`, `remove`, and `dispose`
 * calls cannot observe a half-initialized plugin. Normal installation is
 * always third-party authority; only a trusted Vega distribution should call
 * `installOfficial`.
 */
export class VegaPluginHost {
  readonly lifetime: VegaLifetime;
  readonly events: VegaEventBus<VegaEventMap>;
  private readonly ownsEvents: boolean;
  private readonly commands = new Map<number, VegaRegisteredCommandExtension>();
  private readonly services = new Map<string, unknown>();
  private readonly contributionRegistry = new Map<
    keyof VegaContributionMap,
    Map<string, RegisteredContribution<VegaContribution>>
  >();
  private readonly installed = new Map<string, InstalledPlugin>();
  private operationTail: Promise<void> = Promise.resolve();
  private acceptingOperations = true;
  private disposal: Promise<void> | null = null;

  constructor(lifetime = new VegaLifetime("vega/plugins"), events?: VegaEventBus<VegaEventMap>) {
    this.lifetime = lifetime;
    this.events = events ?? new VegaEventBus<VegaEventMap>();
    this.ownsEvents = !events;
  }

  get commandExtensions(): ReadonlyMap<number, VegaRegisteredCommandExtension> {
    return new Map(this.commands);
  }

  list(): readonly VegaPluginManifest[] {
    return [...this.installed.values()].map(({ manifest }) => manifest);
  }

  contributions<K extends keyof VegaContributionMap>(kind: K): readonly VegaContributionMap[K][] {
    return this.contributionSelections(kind)
      .filter(({ active }) => active)
      .map(({ contribution }) => contribution);
  }

  contributionSelections<K extends keyof VegaContributionMap>(
    kind: K,
  ): readonly VegaContributionSelection<VegaContributionMap[K]>[] {
    const registry = this.contributionRegistry.get(kind);
    if (!registry) return [];
    const records = [...registry.values()];
    const winners = selectContributionWinners(records);
    return Object.freeze(
      records.map((record) => {
        const winner = winners.get(record);
        return Object.freeze({
          owner: record.owner,
          kind,
          contribution: record.value as VegaContributionMap[K],
          priority: record.priority,
          overrides: record.overrides,
          ...(record.singletonPort !== undefined
            ? { singletonPort: record.singletonPort }
            : {}),
          active: winner === record,
          ...(winner && winner !== record
            ? { suppressedBy: qualifiedContributionId(winner) }
            : {}),
        });
      }),
    );
  }

  service<T>(key: VegaServiceKey<T>): T | undefined {
    return this.services.get(key.id) as T | undefined;
  }

  install(plugin: VegaPlugin): Promise<void> {
    return this.enqueue(() => this.installNow(plugin, "third-party"));
  }

  /**
   * Trusted entry point for extensions shipped by Vega itself. Official
   * authority is supplied by the host and cannot be self-declared in a plugin
   * manifest.
   */
  installOfficial(plugin: VegaPlugin): Promise<void> {
    return this.enqueue(() => this.installNow(plugin, "official"));
  }

  remove(pluginId: string): Promise<void> {
    return this.enqueue(() => this.removeNow(pluginId));
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.acceptingOperations = false;
    this.disposal = this.operationTail.then(async () => {
      const errors: unknown[] = [];
      for (const pluginId of [...this.installed.keys()].reverse()) {
        try {
          await this.removeNow(pluginId);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
      if (this.ownsEvents) this.events.clear();
      if (errors.length) throw new AggregateError(errors, "Failed to dispose the Vega plugin host");
    });
    this.operationTail = this.disposal.then(
      () => undefined,
      () => undefined,
    );
    return this.disposal;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.acceptingOperations) return Promise.reject(new ReferenceError("Vega plugin host is disposing"));
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async installNow(plugin: VegaPlugin, authority: VegaPluginAuthority): Promise<void> {
    const manifest = validateManifest(plugin.manifest);
    if (this.installed.has(manifest.id)) throw new Error(`Vega plugin already installed: ${manifest.id}`);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!this.installed.has(dependency)) {
        throw new Error(`Vega plugin ${manifest.id} requires ${dependency} to be installed first`);
      }
    }

    const lifetime = this.lifetime.child(`plugin:${manifest.id}`);
    const context: VegaPluginContext = {
      lifetime,
      events: this.events,
      registerCommand: (extension) => {
        requireCapability(manifest, "commands");
        return this.registerCommand(manifest.id, authority, lifetime, extension);
      },
      contribute: (kind, contribution, options) => {
        requireCapability(manifest, kind);
        return this.contribute(manifest.id, lifetime, kind, contribution, options);
      },
      provide: (key, value) => this.provide(manifest.id, lifetime, key, value),
      service: (key) => this.services.get(key.id) as never,
    };
    let activation: VegaPluginActivation | undefined;
    let started = false;
    try {
      activation = (await plugin.setup(context)) || undefined;
      if (activation?.dispose) lifetime.defer(() => activation?.dispose?.());
      await activation?.start?.();
      started = true;
      this.installed.set(manifest.id, { plugin, manifest, lifetime, authority, activation });
      await this.events.emit("plugin:installed", { pluginId: manifest.id });
    } catch (error) {
      this.installed.delete(manifest.id);
      const cleanupErrors: unknown[] = [];
      if (started) {
        try {
          await activation?.stop?.();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      try {
        await lifetime.dispose();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError([error, ...cleanupErrors], `Failed to install Vega plugin ${manifest.id}`);
      }
      throw error;
    }
  }

  private async removeNow(pluginId: string): Promise<void> {
    const installed = this.installed.get(pluginId);
    if (!installed) return;
    const dependants = [...this.installed.values()]
      .filter(({ manifest }) => Object.hasOwn(manifest.dependencies ?? {}, pluginId))
      .map(({ manifest }) => manifest.id);
    if (dependants.length) throw new Error(`Cannot remove ${pluginId}; required by ${dependants.join(", ")}`);

    this.installed.delete(pluginId);
    const errors: unknown[] = [];
    try {
      await installed.activation?.stop?.();
    } catch (error) {
      errors.push(error);
    }
    try {
      await installed.lifetime.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.events.emit("plugin:removed", { pluginId });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, `Failed to remove Vega plugin ${pluginId}`);
  }

  private registerCommand(
    owner: string,
    authority: VegaPluginAuthority,
    lifetime: VegaLifetime,
    extension: VegaCommandExtension,
  ): () => void {
    const opcode = Number(extension.opcode);
    const allowed =
      authority === "official" ? isVegaOfficialExtensionOpcode(opcode) : isVegaThirdPartyOpcode(opcode);
    if (!allowed) {
      const expected =
        authority === "official"
          ? `${VEGA_OFFICIAL_EXTENSION_RANGE.minimum}-${VEGA_OFFICIAL_EXTENSION_RANGE.maximum}`
          : `>=${VEGA_THIRD_PARTY_OPCODE_MINIMUM}`;
      throw new RangeError(
        `${authority === "official" ? "Official" : "Third-party"} plugin ${owner} cannot register opcode ${
          extension.opcode
        }; expected ${expected}`,
      );
    }
    if (!extension.name.trim()) throw new TypeError(`Vega command ${opcode} from ${owner} has no name`);
    if (this.commands.has(opcode)) throw new Error(`Vega opcode ${opcode} is already registered`);
    const value = Object.freeze({ ...extension, opcode, owner, authority });
    this.commands.set(opcode, value);
    const remove = () => {
      if (this.commands.get(opcode) === value) this.commands.delete(opcode);
    };
    lifetime.defer(remove);
    return remove;
  }

  private provide<T>(owner: string, lifetime: VegaLifetime, key: VegaServiceKey<T>, value: T): () => void {
    if (!key.id.trim()) throw new TypeError(`Plugin ${owner} provided a service without an id`);
    if (this.services.has(key.id)) throw new Error(`Vega service already provided: ${key.id}`);
    this.services.set(key.id, value);
    const remove = () => {
      if (this.services.get(key.id) === value) this.services.delete(key.id);
    };
    lifetime.defer(remove);
    return remove;
  }

  private contribute<K extends keyof VegaContributionMap>(
    owner: string,
    lifetime: VegaLifetime,
    kind: K,
    contribution: VegaContributionMap[K],
    options: VegaContributionOptions | undefined,
  ): () => void {
    if (!contribution.id?.trim()) throw new TypeError(`Plugin ${owner} contributed ${kind} without an id`);
    const registry =
      this.contributionRegistry.get(kind) ?? new Map<string, RegisteredContribution<VegaContribution>>();
    if (registry.has(contribution.id)) {
      throw new Error(`Vega ${kind} contribution already registered: ${contribution.id}`);
    }
    const normalizedOptions = normalizeContributionOptions(owner, kind, options);
    const registered = Object.freeze({
      owner,
      value: Object.freeze(contribution),
      ...normalizedOptions,
    });
    registry.set(contribution.id, registered);
    this.contributionRegistry.set(kind, registry);
    const remove = () => {
      if (registry.get(contribution.id) !== registered) return;
      registry.delete(contribution.id);
      if (!registry.size) this.contributionRegistry.delete(kind);
    };
    lifetime.defer(remove);
    return remove;
  }
}

const normalizeContributionOptions = (
  owner: string,
  kind: keyof VegaContributionMap,
  options: VegaContributionOptions | undefined,
): Pick<
  RegisteredContribution<VegaContribution>,
  "priority" | "overrides" | "singletonPort"
> => {
  if (options !== undefined && (!options || typeof options !== "object")) {
    throw new TypeError(`Plugin ${owner} supplied invalid ${kind} contribution options`);
  }
  const priority = options?.priority ?? 0;
  if (!Number.isSafeInteger(priority)) {
    throw new TypeError(
      `Plugin ${owner} supplied a non-integer ${kind} contribution priority`,
    );
  }
  const rawOverrides =
    typeof options?.override === "string"
      ? [options.override]
      : options?.override ?? [];
  if (
    !Array.isArray(rawOverrides) ||
    rawOverrides.some((selector) => typeof selector !== "string" || !selector.trim())
  ) {
    throw new TypeError(
      `Plugin ${owner} supplied invalid ${kind} contribution overrides`,
    );
  }
  if (
    options?.singletonPort !== undefined &&
    (typeof options.singletonPort !== "string" || !options.singletonPort.trim())
  ) {
    throw new TypeError(
      `Plugin ${owner} supplied an invalid ${kind} singleton port`,
    );
  }
  return {
    priority,
    overrides: Object.freeze(
      [...new Set(rawOverrides.map((selector) => selector.trim()))].sort(
        compareStableText,
      ),
    ),
    ...(options?.singletonPort !== undefined
      ? { singletonPort: options.singletonPort.trim() }
      : {}),
  };
};

const selectContributionWinners = (
  records: readonly RegisteredContribution<VegaContribution>[],
): ReadonlyMap<
  RegisteredContribution<VegaContribution>,
  RegisteredContribution<VegaContribution>
> => {
  const parent = new Map(
    records.map((record) => [record, record] as const),
  );
  const find = (
    record: RegisteredContribution<VegaContribution>,
  ): RegisteredContribution<VegaContribution> => {
    const current = parent.get(record)!;
    if (current === record) return record;
    const root = find(current);
    parent.set(record, root);
    return root;
  };
  const union = (
    left: RegisteredContribution<VegaContribution>,
    right: RegisteredContribution<VegaContribution>,
  ): void => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const first =
      compareStableText(qualifiedContributionId(a), qualifiedContributionId(b)) <= 0
        ? a
        : b;
    parent.set(a === first ? b : a, first);
  };

  const singletonOwners = new Map<
    string,
    RegisteredContribution<VegaContribution>
  >();
  for (const record of records) {
    if (!record.singletonPort) continue;
    const existing = singletonOwners.get(record.singletonPort);
    if (existing) union(existing, record);
    else singletonOwners.set(record.singletonPort, record);
  }
  for (const record of records) {
    for (const selector of record.overrides) {
      for (const target of records) {
        if (
          target !== record &&
          (selector === target.value.id ||
            selector === qualifiedContributionId(target))
        ) {
          union(record, target);
        }
      }
    }
  }

  const groups = new Map<
    RegisteredContribution<VegaContribution>,
    RegisteredContribution<VegaContribution>[]
  >();
  for (const record of records) {
    const root = find(record);
    const group = groups.get(root) ?? [];
    group.push(record);
    groups.set(root, group);
  }
  const winners = new Map<
    RegisteredContribution<VegaContribution>,
    RegisteredContribution<VegaContribution>
  >();
  for (const group of groups.values()) {
    const winner = group.reduce(preferredContribution);
    for (const record of group) winners.set(record, winner);
  }
  return winners;
};

const preferredContribution = (
  left: RegisteredContribution<VegaContribution>,
  right: RegisteredContribution<VegaContribution>,
): RegisteredContribution<VegaContribution> => {
  if (left.priority !== right.priority) {
    return left.priority > right.priority ? left : right;
  }
  const leftOverrides = contributionOverrides(left, right);
  const rightOverrides = contributionOverrides(right, left);
  if (leftOverrides !== rightOverrides) return leftOverrides ? left : right;
  return compareStableText(
    qualifiedContributionId(left),
    qualifiedContributionId(right),
  ) <= 0
    ? left
    : right;
};

const contributionOverrides = (
  candidate: RegisteredContribution<VegaContribution>,
  target: RegisteredContribution<VegaContribution>,
): boolean =>
  candidate.overrides.includes(target.value.id) ||
  candidate.overrides.includes(qualifiedContributionId(target));

const qualifiedContributionId = (
  contribution: RegisteredContribution<VegaContribution>,
): string => `${contribution.owner}:${contribution.value.id}`;

const compareStableText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const PLUGIN_CAPABILITIES = new Set<VegaPluginCapability>([
  "commands",
  "rich-text",
  "theme",
  "ui-slot",
  "render",
  "character",
  "effect",
  "resource",
  "audio",
  "input",
  "storage",
  "diagnostics",
]);

const validateManifest = (candidate: VegaPluginManifest): VegaPluginManifest => {
  if (!candidate || typeof candidate !== "object") throw new TypeError("Vega plugin manifest must be an object");
  const manifest = candidate as Partial<VegaPluginManifest>;
  if (typeof manifest.id !== "string" || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    throw new TypeError(`Invalid Vega plugin id: ${String(manifest.id)}`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    throw new TypeError(`Vega plugin ${manifest.id} has no name`);
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new TypeError(`Vega plugin ${manifest.id} has no version`);
  }
  if (manifest.apiVersion !== VEGA_PLUGIN_API_VERSION) {
    throw new RangeError(
      `Plugin ${manifest.id} uses API ${manifest.apiVersion}; Vega supports ${VEGA_PLUGIN_API_VERSION}`,
    );
  }
  let dependencies: Readonly<Record<string, string>> | undefined;
  if (manifest.dependencies !== undefined) {
    if (
      !manifest.dependencies ||
      typeof manifest.dependencies !== "object" ||
      Array.isArray(manifest.dependencies)
    ) {
      throw new TypeError(`Vega plugin ${manifest.id} dependencies must be an object`);
    }
    const entries = Object.entries(manifest.dependencies);
    for (const [dependency, version] of entries) {
      if (!PLUGIN_ID_PATTERN.test(dependency) || typeof version !== "string" || !version.trim()) {
        throw new TypeError(`Vega plugin ${manifest.id} has an invalid dependency ${dependency}`);
      }
    }
    dependencies = Object.freeze(Object.fromEntries(entries));
  }
  let capabilities: readonly VegaPluginCapability[] | undefined;
  if (manifest.capabilities !== undefined) {
    if (!Array.isArray(manifest.capabilities)) {
      throw new TypeError(`Vega plugin ${manifest.id} capabilities must be an array`);
    }
    const values = manifest.capabilities as readonly unknown[];
    if (
      values.some((value) => typeof value !== "string" || !PLUGIN_CAPABILITIES.has(value as VegaPluginCapability))
    ) {
      throw new TypeError(`Vega plugin ${manifest.id} declares an unknown capability`);
    }
    capabilities = Object.freeze([...new Set(values as readonly VegaPluginCapability[])]);
  }
  return Object.freeze({
    ...candidate,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: VEGA_PLUGIN_API_VERSION,
    dependencies,
    capabilities,
  });
};

const requireCapability = (manifest: VegaPluginManifest, capability: VegaPluginCapability): void => {
  if (!manifest.capabilities?.includes(capability)) {
    throw new Error(`Vega plugin ${manifest.id} must declare the ${capability} capability`);
  }
};
