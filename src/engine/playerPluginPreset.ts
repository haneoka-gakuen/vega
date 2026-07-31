import type { AdvCommandExtensionRegistration } from "../core/AdvPlayer";
import type { StoryCharacterProvider } from "../rendering/StoryCharacterModel";
import type {
  StoryRendererExtensionRegistry,
  StoryRendererServiceKey,
} from "../rendering/StoryRendererExtensions";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import type { VegaLifetime } from "./lifecycle";
import type {
  VegaInputContribution,
  VegaRenderContribution,
  VegaServiceKey,
  VegaStorageContribution,
  VegaThemeContribution,
  VegaUiSlotContribution,
} from "./plugins";
import { VEGA_STORAGE_PORT, VegaPluginHost, type VegaPlugin } from "./plugins";

export interface VegaOfficialPlayerPluginPreset {
  readonly lifetime: VegaLifetime;
  readonly resources: DefaultStoryResourceResolver;
  readonly characterProviders: readonly StoryCharacterProvider[];
  readonly rendererExtensions: StoryRendererExtensionRegistry;
  readonly commandExtensions: readonly AdvCommandExtensionRegistration[];
  readonly themes: readonly VegaThemeContribution[];
  readonly uiSlots: readonly VegaUiSlotContribution[];
  readonly inputContributions: readonly VegaInputContribution[];
  readonly storageContributions: readonly VegaStorageContribution[];
  readonly storageContribution?: VegaStorageContribution;
  readonly renderContribution?: VegaRenderContribution;
  service<T>(key: VegaServiceKey<T>): T | undefined;
  dispose(): Promise<void>;
}

export interface ResolveVegaOfficialPlayerPluginsOptions {
  readonly plugins: readonly VegaPlugin[];
  readonly renderBackend?: string;
  readonly signal?: AbortSignal;
}

const abortReason = (signal: AbortSignal): unknown => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Vega player plugin resolution was aborted");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortReason(signal);
};

export const selectVegaRenderContribution = (
  contributions: readonly VegaRenderContribution[],
  selector?: string,
): VegaRenderContribution | undefined => {
  if (selector) {
    const selected = contributions.find(
      ({ id, backend }) => id === selector || backend === selector,
    );
    if (!selected) {
      throw new Error(`Vega render backend is not installed: ${selector}`);
    }
    return selected;
  }
  if (contributions.length <= 1) return contributions[0];
  throw new Error(
    `Multiple Vega render backends are installed (${contributions
      .map(({ backend }) => backend)
      .join(", ")}); select one with renderBackend`,
  );
};

/**
 * Resolve a trusted plugin preset for one framework player instance.
 *
 * No global runtime configuration is mutated. If construction is aborted or
 * fails, every plugin installed so far is disposed before rejection.
 */
export const resolveVegaOfficialPlayerPlugins = async ({
  plugins,
  renderBackend,
  signal,
}: ResolveVegaOfficialPlayerPluginsOptions): Promise<VegaOfficialPlayerPluginPreset> => {
  throwIfAborted(signal);
  const host = new VegaPluginHost();
  const abort = () => {
    void host.dispose();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (const plugin of plugins) {
      throwIfAborted(signal);
      await host.installOfficial(plugin);
    }
    throwIfAborted(signal);
    const effects = Object.freeze([...host.contributions("effect")]);
    const rendererExtensions: StoryRendererExtensionRegistry = Object.freeze({
      effects,
      service: <T>(key: StoryRendererServiceKey<T>) => host.service(key),
    });
    const commandExtensions = Object.freeze(
      [...host.commandExtensions.values()].map(
        ({ opcode, execute, authority }) => ({ opcode, execute, authority }),
      ),
    );
    const themes = Object.freeze([...host.contributions("theme")]);
    const uiSlots = Object.freeze([...host.contributions("ui-slot")]);
    const inputContributions = Object.freeze([...host.contributions("input")]);
    const storageContributions = Object.freeze([
      ...host.contributions("storage"),
    ]);
    const storageContribution = selectVegaStorageContribution(host);
    const preset: VegaOfficialPlayerPluginPreset = Object.freeze({
      lifetime: host.lifetime,
      resources: new DefaultStoryResourceResolver(
        host.contributions("resource"),
      ),
      characterProviders: Object.freeze([
        ...host.contributions("character"),
      ]),
      rendererExtensions,
      commandExtensions,
      themes,
      uiSlots,
      inputContributions,
      storageContributions,
      ...(storageContribution ? { storageContribution } : {}),
      renderContribution: selectVegaRenderContribution(
        host.contributions("render"),
        renderBackend,
      ),
      service: <T>(key: VegaServiceKey<T>) => host.service(key),
      dispose: () => host.dispose(),
    });
    return preset;
  } catch (error) {
    await host.dispose();
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
};

const selectVegaStorageContribution = (
  host: VegaPluginHost,
): VegaStorageContribution | undefined => {
  const active = host
    .contributionSelections("storage")
    .filter(({ active }) => active);
  const explicit = active.filter(
    ({ singletonPort }) => singletonPort === VEGA_STORAGE_PORT,
  );
  const compatible = explicit.length
    ? explicit
    : active.filter(({ singletonPort }) => singletonPort === undefined);
  return [...compatible].sort((left, right) => {
    if (left.priority !== right.priority) {
      return right.priority - left.priority;
    }
    const leftId = `${left.owner}:${left.contribution.id}`;
    const rightId = `${right.owner}:${right.contribution.id}`;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  })[0]?.contribution;
};
