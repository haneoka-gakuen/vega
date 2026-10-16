import { AdvPlayer } from "../../core/AdvPlayer";
import { mergeAdvRuntime } from "../../core/AdvConstants";
import { GenericStoryScene } from "../../rendering/dom/GenericStoryScene";
import { VegaMemorySaveStorage, type VegaSaveStorage } from "../../narrative/save";
import { VegaLocalStorageSaveStorage } from "./saveStorage";
import { VegaNarrativeStore } from "../../narrative/state";
import type { StorySceneBackend } from "../../rendering/StorySceneBackend";
import type { StoryRendererExtensionRegistry, StoryRendererServiceKey } from "../../rendering/StoryRendererExtensions";
import { DefaultStoryResourceResolver } from "../../resources/StoryResourceResolver";
import { createVegaShellController, type VegaManagedShellController } from "../../shell/controller";
import { VEGA_SHELL_CONTROLLER, type VegaShellController } from "../../shell/contracts";
import { VEGA_TEXT_METRICS } from "../../core/AdvTextRenderValue";
import { VegaLifetime } from "../../engine/lifecycle";
import { createVegaPlayerPresentation, mountVegaUiSlots, type VegaPlayerPresentation } from "./playerPresentation";
import { createBrowserNarrativeInput } from "./browserNarrativeInput";
import { selectVegaRenderContribution } from "../../engine/playerPluginPreset";
import { type VegaServiceKey } from "../../engine/plugins";

import {
  createVegaPlayerState,
  type VegaHostedPlayer,
  type VegaPlayerHost,
  type VegaPlayerService,
} from "../../engine/VegaEngine";
import type { VegaWebPlayerOptions } from "./engine";
import { createRustVegaExecutionDriver } from "../../execution/wasm";

/** Web composition owns DOM, input, browser persistence, shell and legacy media. */
export const createVegaWebPlayerHost = (): VegaPlayerHost => {
  let defaultSaveStorage: VegaSaveStorage | undefined;
  return {
    async create({ engine, id, lifetime }, hostOptions): Promise<VegaHostedPlayer> {
      const options = { ...hostOptions, mount: hostOptions.surface } as VegaWebPlayerOptions;
      const state = options.state ?? createVegaPlayerState();
      const narrativeStore = options.narrativeStore ?? new VegaNarrativeStore();
      const commandExtensions = [...engine.plugins.commandExtensions.values()].map(
        ({
          opcode,
          commandType,
          execute,
          authority,
          replaySafe,
          prepareStoryResources,
          enumerateCommandResources,
        }) => ({
          opcode,
          commandType,
          execute,
          authority,
          replaySafe,
          prepareStoryResources,
          enumerateCommandResources,
        }),
      );
      const resources = options.resources ?? new DefaultStoryResourceResolver(engine.plugins.contributions("resource"));
      let presentation: VegaPlayerPresentation | undefined;
      let player: AdvPlayer | undefined;
      let constructedPlayerDisposal: Promise<void> | undefined;
      let sceneBackend: StorySceneBackend | undefined;
      let shell: VegaManagedShellController | VegaShellController | undefined;
      try {
        presentation = createVegaPlayerPresentation({
          engineId: engine.id,
          playerId: id,
          mount: options.mount,
          lifetime,
          themes: engine.plugins.contributions("theme"),
          theme: options.theme,
          uiSlots: engine.plugins.contributions("ui-slot"),
        });
        const renderContribution = selectVegaRenderContribution(
          engine.plugins.contributions("render"),
          options.renderBackend,
        );
        const characterProviders = engine.plugins.contributions("character");
        if (renderContribution) {
          const rendererExtensions: StoryRendererExtensionRegistry = Object.freeze({
            effects: Object.freeze([...engine.plugins.contributions("effect")]),
            service: <T>(key: StoryRendererServiceKey<T>) => engine.plugins.service(key),
          });
          const context = {
            runtime: mergeAdvRuntime(options.story.runtime),
            state,
            resources,
            characterProviders,
            rendererExtensions,
            signal: lifetime.signal,
          };
          sceneBackend = await renderContribution.create(context, lifetime.signal);
          if (!sceneBackend || typeof sceneBackend.setup !== "function" || typeof sceneBackend.destroy !== "function") {
            throw new TypeError(`Vega render contribution ${renderContribution.id} did not create a scene backend`);
          }
        }
        const browserInput =
          options.narrativeInput || !presentation.root.ownerDocument?.defaultView
            ? undefined
            : createBrowserNarrativeInput(presentation.root, lifetime.signal);
        if (browserInput) lifetime.use(browserInput);
        // Without a render plugin, fall back to the portable DOM renderer.
        sceneBackend ??= new GenericStoryScene(mergeAdvRuntime(options.story.runtime), state, resources, {
          characterProviders,
        });
        const executionDriver =
          options.executionDriver ??
          (await createRustVegaExecutionDriver((options.story.commands ?? []).map((_, index) => index)));
        if (lifetime.signal.aborted) {
          executionDriver.dispose();
          throwIfAborted(lifetime.signal);
        }
        lifetime.use(executionDriver);
        throwIfAborted(lifetime.signal);
        player = new AdvPlayer({
          executionDriver,
          mount: presentation.stage,
          story: options.story,
          resolveLocalizedText: options.resolveLocalizedText,
          displayNameJoiner: options.displayNameJoiner,
          state,
          commandExtensions,
          sceneBackend,
          resources,
          narrativeStore,
          narrativeInput: options.narrativeInput ?? browserInput?.provider,
          characterProviders,
          resourcePreparers: presentation.theme ? [presentation.theme] : [],
          textMetrics: engine.plugins.service(VEGA_TEXT_METRICS),
        });
        const constructedPlayer = player;
        const disposeConstructedPlayer = (): Promise<void> => {
          if (!constructedPlayerDisposal) {
            try {
              constructedPlayerDisposal = constructedPlayer.dispose({ releaseTextures: true });
            } catch (error) {
              constructedPlayerDisposal = Promise.reject(error);
            }
          }
          return constructedPlayerDisposal;
        };
        // Abort retires Loader/audio/command ownership before a UI finalizer
        // can wait on it. The deferred cleanup still awaits scene destruction.
        const onPlayerAbort = (): void => {
          void disposeConstructedPlayer().catch((error) => {
            console.error("[Vega] player disposal after lifetime abort failed", error);
          });
        };
        if (lifetime.signal.aborted) onPlayerAbort();
        else lifetime.signal.addEventListener("abort", onPlayerAbort, { once: true });
        lifetime.defer(() => {
          lifetime.signal.removeEventListener("abort", onPlayerAbort);
          return disposeConstructedPlayer();
        });
        throwIfAborted(lifetime.signal);
        const playerServices = playerServiceMap(options.services);
        const configuredShell = playerServices.get(VEGA_SHELL_CONTROLLER.id) as VegaShellController | undefined;
        const engineShell = engine.plugins.service(VEGA_SHELL_CONTROLLER);
        const uiRequiresShell = engine.plugins
          .contributions("ui-slot")
          .some((contribution) =>
            contribution.requiredServices?.some(({ id: serviceId }) => serviceId === VEGA_SHELL_CONTROLLER.id),
          );
        if (configuredShell || engineShell) {
          shell = configuredShell ?? engineShell;
        } else if (options.shell !== false && (options.shell !== undefined || uiRequiresShell)) {
          const shellOptions = options.shell || {};
          shell = await createVegaShellController({
            player: constructedPlayer,
            story: options.story,
            narrativeStore,
            storage:
              shellOptions.storage ?? (defaultSaveStorage ??= browserSaveStorage() ?? new VegaMemorySaveStorage()),
            projectId: shellOptions.projectId,
            settingsId: shellOptions.settingsId,
            initialSettings: shellOptions.initialSettings,
            title: shellOptions.title,
            initialScreen: shellOptions.initialScreen,
            root: presentation.root,
            signal: lifetime.signal,
            onExitRequest: async () => {
              await shellOptions.onExitRequest?.();
              await engine.events.emit("shell:exit-request", { engineId: engine.id, playerId: id });
            },
          });
          lifetime.use(shell);
          playerServices.set(VEGA_SHELL_CONTROLLER.id, shell);
        }
        await mountVegaUiSlots({
          resources,
          contributions: engine.plugins.contributions("ui-slot"),
          presentation,
          lifetime,
          engineId: engine.id,
          playerId: id,
          player: constructedPlayer,
          state,
          service: (key) =>
            playerServices.has(key.id) ? (playerServices.get(key.id) as never) : engine.plugins.service(key),
        });
        await constructedPlayer.boot();
        throwIfAborted(lifetime.signal);
      } catch (error) {
        const cleanup = [lifetime.dispose()];
        if (!player && sceneBackend)
          cleanup.push(Promise.resolve().then(() => sceneBackend!.destroy({ releaseTextures: true })));
        if (constructedPlayerDisposal) cleanup.push(constructedPlayerDisposal);
        const failures = (await Promise.allSettled(cleanup))
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length)
          throw new AggregateError([error, ...failures], "Vega player construction and cleanup failed");
        throw error;
      }
      return { player: player!, root: presentation!.root, slots: presentation!.slots, ...(shell ? { shell } : {}) };
    },
  };
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted)
    throw signal.reason ?? Object.assign(new Error("Vega player creation aborted"), { name: "AbortError" });
};

const playerServiceMap = (services: readonly VegaPlayerService[] | undefined): Map<string, unknown> => {
  const result = new Map<string, unknown>();
  for (const service of services ?? []) {
    if (!service.key.id.trim()) throw new TypeError("Vega player service key must not be empty");
    if (result.has(service.key.id)) throw new Error(`Duplicate Vega player service: ${service.key.id}`);
    result.set(service.key.id, service.value);
  }
  return result;
};

const browserSaveStorage = (): VegaSaveStorage | undefined => {
  if (typeof window === "undefined") return undefined;
  try {
    const storage = window.localStorage;
    return storage ? new VegaLocalStorageSaveStorage(storage) : undefined;
  } catch {
    return undefined;
  }
};
