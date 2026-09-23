import { decodeVegaBundle, parseVegaProject, type VegaProject } from "@haneoka/vega-protocol";
import type { AdvStory } from "../types/AdvRuntime";
import { VegaEngine, createVega, type VegaEngineOptions, type VegaPlayerHandle } from "./VegaEngine";
import { bindVegaProject, type VegaProjectBinding } from "./projectRuntime";
import { loadDenebRuntimePlugins } from "./denebPlugins";

export const DENEB_RUNTIME_ABI_VERSION = 1 as const;
export const DENEB_RUNTIME_CAPABILITIES = Object.freeze([
  "adv-story",
  "lifecycle-v1",
  "vega-project-v1",
  "vega-project-assets-v1",
  "vega-project-multiscene-v1",
  "vega-bundle-v1",
  "deneb-manifest-v1",
  "deneb-runtime-plugins-v1",
  "deneb-external-runtimes-v1",
] as const);

export interface DenebRuntimeFactoryOptions {
  readonly abiVersion: number;
  readonly capabilities?: readonly string[];
  readonly signal?: AbortSignal;
  readonly engineOptions?: VegaEngineOptions;
  /** Keep playback paused until an explicitly installed shell resumes it. */
  readonly standaloneShell?: boolean;
  /** Deneb-generated, integrity-bound browser plugin index. */
  readonly runtimePluginIndexUrl?: string | URL;
  /** Host requirements and authorized application-private runtime files. */
  readonly externalRuntimeIndexUrl?: string | URL;
}

export interface DenebRuntimeMountOptions {
  readonly root: HTMLElement;
  readonly project?: VegaProject | AdvStory;
  readonly projectUrl?: string | URL;
  readonly bundleUrl?: string | URL;
  readonly manifestUrl?: string | URL;
  readonly sceneId?: string;
  readonly theme?: string | false;
  readonly runtimePluginIndexUrl?: string | URL;
  readonly externalRuntimeIndexUrl?: string | URL;
  readonly signal?: AbortSignal;
}

export interface DenebRuntimeMount {
  readonly player: VegaPlayerHandle;
  /** Settles when playback finishes or rejects when command execution fails. */
  readonly playback: Promise<void>;
  dispose(): Promise<void>;
}

export interface DenebRuntime {
  readonly abiVersion: typeof DENEB_RUNTIME_ABI_VERSION;
  readonly capabilities: typeof DENEB_RUNTIME_CAPABILITIES;
  mount(options: DenebRuntimeMountOptions): Promise<DenebRuntimeMount>;
  dispose(): Promise<void>;
}

/**
 * Versioned ESM factory consumed by Deneb's generated web shell.
 *
 * The factory deliberately reuses `VegaEngine`; the Deneb adapter only owns
 * project loading and mount lifecycle and does not fork command semantics.
 */
export const createDenebRuntime = async (options: DenebRuntimeFactoryOptions): Promise<DenebRuntime> => {
  if (options.abiVersion !== DENEB_RUNTIME_ABI_VERSION) {
    throw new RangeError(
      `Unsupported Deneb runtime ABI ${options.abiVersion}; Vega supports ${DENEB_RUNTIME_ABI_VERSION}`,
    );
  }
  if (options.signal?.aborted) throw options.signal.reason;
  for (const capability of options.capabilities ?? []) {
    if (!(DENEB_RUNTIME_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new RangeError(`Unsupported Deneb runtime capability: ${capability}`);
    }
  }

  let engine: VegaEngine | undefined;
  let engineInitialization: Promise<VegaEngine> | undefined;
  let runtimePluginIndexUrl: string | undefined;
  let externalRuntimeIndexUrl: string | undefined;
  const mounts = new Set<DenebRuntimeMount>();
  const lifetime = new AbortController();
  const engineSignal = combineAbortSignals(options.signal, lifetime.signal);
  let disposed = false;
  let disposal: Promise<void> | null = null;

  const ensureEngine = (mountOptions?: DenebRuntimeMountOptions): Promise<VegaEngine> => {
    const requestedRuntimePlugins = normalizedUrl(options.runtimePluginIndexUrl ?? mountOptions?.runtimePluginIndexUrl);
    const requestedExternalRuntimes = normalizedUrl(
      options.externalRuntimeIndexUrl ?? mountOptions?.externalRuntimeIndexUrl,
    );
    if (
      engineInitialization &&
      (requestedRuntimePlugins !== runtimePluginIndexUrl || requestedExternalRuntimes !== externalRuntimeIndexUrl)
    ) {
      return Promise.reject(new TypeError("A Deneb runtime instance cannot switch plugin or external-runtime indexes"));
    }
    if (engineInitialization) return engineInitialization;
    runtimePluginIndexUrl = requestedRuntimePlugins;
    externalRuntimeIndexUrl = requestedExternalRuntimes;
    const initialization = (async () => {
      let created: VegaEngine | undefined;
      const loaded = await loadDenebRuntimePlugins({
        ...(runtimePluginIndexUrl ? { runtimePluginIndexUrl } : {}),
        ...(externalRuntimeIndexUrl ? { externalRuntimeIndexUrl } : {}),
        signal: engineSignal.signal,
      });
      if (disposed) {
        throw new ReferenceError("The Deneb Vega runtime was disposed while loading plugins");
      }
      created = createVega({
        ...options.engineOptions,
        plugins: [...loaded.plugins, ...(options.engineOptions?.plugins ?? [])],
        officialPlugins: [...(options.engineOptions?.officialPlugins ?? [])],
      });
      engine = created;
      try {
        await created.start();
        return created;
      } catch (error) {
        engine = undefined;
        await created.dispose().catch(() => undefined);
        throw error;
      }
    })();
    engineInitialization = initialization.catch((error) => {
      if (!disposed) {
        engineInitialization = undefined;
        runtimePluginIndexUrl = undefined;
        externalRuntimeIndexUrl = undefined;
      }
      throw error;
    });
    void engineInitialization.catch(() => undefined);
    return engineInitialization;
  };

  const runtime: DenebRuntime = {
    abiVersion: DENEB_RUNTIME_ABI_VERSION,
    capabilities: DENEB_RUNTIME_CAPABILITIES,
    async mount(mountOptions) {
      if (disposed) throw new ReferenceError("The Deneb Vega runtime is disposed");
      if (!(mountOptions.root instanceof HTMLElement)) throw new TypeError("Deneb mount root must be an HTMLElement");
      const combined = combineAbortSignals(options.signal, mountOptions.signal);
      try {
        if (combined.signal.aborted) throw combined.signal.reason;
        const activeEngine = await ensureEngine(mountOptions);
        if (combined.signal.aborted) throw combined.signal.reason;
        const binding = await resolveStory(mountOptions, combined.signal);
        const player = await activeEngine.createPlayer({
          mount: mountOptions.root,
          story: binding.story,
          ...(mountOptions.theme !== undefined ? { theme: mountOptions.theme } : {}),
        });
        if (binding.entryKey) player.player.navigateToKey(binding.entryKey);
        if (options.standaloneShell) player.player.pause();
        const playback = player.player.play();
        let mountDisposal: Promise<void> | null = null;
        const mounted: DenebRuntimeMount = {
          player,
          playback,
          dispose() {
            if (mountDisposal) return mountDisposal;
            mounts.delete(mounted);
            combined.dispose();
            mountDisposal = player.dispose();
            return mountDisposal;
          },
        };
        mounts.add(mounted);
        void playback.catch(() => mounted.dispose().catch(() => undefined));
        combined.signal.addEventListener(
          "abort",
          () => {
            void mounted.dispose().catch(() => undefined);
          },
          { once: true },
        );
        if (combined.signal.aborted) await mounted.dispose();
        return mounted;
      } catch (error) {
        combined.dispose();
        throw error;
      }
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      lifetime.abort(new DOMException("The Deneb Vega runtime was disposed", "AbortError"));
      disposal = (async () => {
        const results = await Promise.allSettled([...mounts].map((mounted) => mounted.dispose()));
        mounts.clear();
        try {
          let activeEngine = engine;
          if (!activeEngine && engineInitialization) {
            activeEngine = await engineInitialization.catch(() => undefined);
          }
          await activeEngine?.dispose();
        } catch (error) {
          results.push({ status: "rejected", reason: error });
        }
        options.signal?.removeEventListener("abort", disposeFromSignal);
        engineSignal.dispose();
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map(({ reason }) => reason);
        if (errors.length) throw new AggregateError(errors, "Failed to dispose the Deneb Vega runtime");
      })();
      return disposal;
    },
  };

  const disposeFromSignal = () => {
    void runtime.dispose().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", disposeFromSignal, { once: true });
  if (options.signal?.aborted) {
    await runtime.dispose();
    throw options.signal.reason;
  }
  return runtime;
};

const normalizedUrl = (value: string | URL | undefined): string | undefined =>
  value === undefined ? undefined : new URL(String(value), globalThis.document?.baseURI ?? "http://localhost/").href;

const resolveStory = async (options: DenebRuntimeMountOptions, signal: AbortSignal): Promise<VegaProjectBinding> => {
  if (options.manifestUrl) await validateDenebManifest(options.manifestUrl, signal);
  if (options.project) return bindVegaProject(options.project, options.sceneId);
  if (options.projectUrl) {
    const response = await fetch(options.projectUrl, { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Vega project request failed (${response.status})`);
    return bindVegaProject(parseVegaProject(await response.text()), options.sceneId);
  }
  if (options.bundleUrl) {
    const response = await fetch(options.bundleUrl, { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Vega bundle request failed (${response.status})`);
    const bundle = decodeVegaBundle(new Uint8Array(await response.arrayBuffer()));
    return bindVegaProject(parseVegaProject(bundle.project), options.sceneId);
  }
  throw new TypeError("Deneb mount requires project, projectUrl, or bundleUrl");
};

export { vegaProjectToAdvStory } from "./projectRuntime";

const validateDenebManifest = async (url: string | URL, signal: AbortSignal): Promise<void> => {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`Deneb build manifest request failed (${response.status})`);
  const manifest = (await response.json()) as unknown;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Deneb build manifest must be an object");
  }
  const value = manifest as Record<string, unknown>;
  if (value.format !== "deneb-build" || value.formatVersion !== 1 || value.runtimeAbiVersion !== 1) {
    throw new TypeError("Unsupported Deneb build manifest");
  }
};

const combineAbortSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const available = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const abort = (event: Event) => {
    const signal = event.target as AbortSignal;
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of available) {
    if (signal.aborted && !controller.signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of available) signal.removeEventListener("abort", abort);
    },
  };
};
