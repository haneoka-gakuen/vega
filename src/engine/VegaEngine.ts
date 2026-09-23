import { AdvPlayer } from "../core/AdvPlayer";
import type { AdvCommandExecutor } from "../core/AdvCommandService";
import { mergeAdvRuntime } from "../core/AdvConstants";
import type { VegaNarrativeInputProvider } from "../narrative/commands";
import { VegaLocalStorageSaveStorage, VegaMemorySaveStorage, type VegaSaveStorage } from "../narrative/save";
import { VegaNarrativeStore } from "../narrative/state";
import type { StorySceneBackend } from "../rendering/StorySceneBackend";
import type { StoryRendererExtensionRegistry, StoryRendererServiceKey } from "../rendering/StoryRendererExtensions";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import type { AdvPlayerState, AdvStory } from "../types/AdvRuntime";
import { createVegaShellController, type VegaManagedShellController } from "../shell/controller";
import { VEGA_SHELL_CONTROLLER, type VegaShellController } from "../shell/contracts";
import { VegaEventBus, type VegaEventHandler, type VegaEventMap } from "./events";
import { VegaLifetime } from "./lifecycle";
import { createVegaPlayerPresentation, mountVegaUiSlots, type VegaPlayerPresentation } from "./playerPresentation";
import { createBrowserNarrativeInput } from "./browserNarrativeInput";
import { selectVegaRenderContribution } from "./playerPluginPreset";
import {
  VEGA_STORAGE_PORT,
  VegaPluginHost,
  type VegaInputEvent,
  type VegaPlugin,
  type VegaServiceKey,
  type VegaStorageContribution,
} from "./plugins";

let engineSequence = 0;
let playerSequence = 0;

export interface VegaEngineOptions {
  readonly id?: string;
  /** Plugins supplied by applications always receive third-party authority. */
  readonly plugins?: readonly VegaPlugin[];
  /** Only Vega distribution code should populate this trusted list. */
  readonly officialPlugins?: readonly VegaPlugin[];
}

/**
 * Engine-scoped key/value storage. Missing keys resolve to `undefined`.
 *
 * Calls lazily start the engine, forward cancellation to the selected storage
 * contribution, and fall back to volatile memory when no provider is active.
 */
export interface VegaEngineStorage {
  get<T = unknown>(key: string, signal?: AbortSignal): Promise<T | undefined>;
  set(key: string, value: unknown, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export type VegaInputHandler = VegaEventHandler<VegaInputEvent>;

export interface VegaPlayerOptions {
  readonly mount: HTMLElement;
  readonly story: AdvStory;
  readonly resolveLocalizedText?: AdvPlayer["resolveLocalizedText"];
  readonly state?: AdvPlayerState;
  readonly narrativeStore?: VegaNarrativeStore;
  readonly narrativeInput?: VegaNarrativeInputProvider;
  /** Theme contribution id. `false` leaves the player unthemed. */
  readonly theme?: string | false;
  /** Per-player services take precedence over engine-wide plugin services. */
  readonly services?: readonly VegaPlayerService[];
  /**
   * Explicit shell configuration. A controller is also created when an
   * installed UI contribution declares `VEGA_SHELL_CONTROLLER` as a required
   * service. With neither signal, the minimal player has no shell.
   */
  readonly shell?: false | VegaPlayerShellOptions;
  /**
   * Selects a render contribution by `backend` or contribution id. When one
   * render contribution is installed it is selected automatically.
   */
  readonly renderBackend?: string;
}

export interface VegaPlayerService<T = unknown> {
  readonly key: VegaServiceKey<T>;
  readonly value: T;
}

export interface VegaPlayerShellOptions {
  readonly storage?: VegaSaveStorage;
  readonly projectId?: string;
  readonly settingsId?: string;
  readonly initialSettings?: Parameters<typeof createVegaShellController>[0]["initialSettings"];
  readonly title?: string;
  readonly initialScreen?: "title" | "game";
  readonly onExitRequest?: () => void | Promise<void>;
}

export interface VegaPlayerHandle {
  readonly id: string;
  readonly player: AdvPlayer;
  readonly lifetime: VegaLifetime;
  readonly root: HTMLElement;
  readonly slots: ReadonlyMap<string, HTMLElement>;
  readonly shell?: VegaShellController;
  dispose(): Promise<void>;
}

export type VegaEnginePhase = "created" | "starting" | "ready" | "failed" | "disposing" | "disposed";

interface ActivePlayer {
  readonly id: string;
  readonly lifetime: VegaLifetime;
  disposal: Promise<void> | null;
}

export class VegaEngine {
  readonly id: string;
  readonly lifetime: VegaLifetime;
  readonly events: VegaEventBus<VegaEventMap>;
  readonly plugins: VegaPluginHost;
  readonly storage: VegaEngineStorage;
  private readonly portsLifetime: VegaLifetime;
  private readonly initialization: Promise<void>;
  private readonly pendingPluginInstalls = new Set<Promise<void>>();
  private readonly activePlayers = new Map<string, ActivePlayer>();
  private readonly volatileStorage = new Map<string, unknown>();
  private defaultSaveStorage: VegaSaveStorage | undefined;
  private inputDispatchTail: Promise<void> = Promise.resolve();
  private phaseValue: VegaEnginePhase = "created";
  private startPromise: Promise<this> | null = null;
  private disposal: Promise<void> | null = null;

  constructor(options: VegaEngineOptions = {}) {
    this.id = options.id || `vega-${++engineSequence}`;
    this.lifetime = new VegaLifetime(this.id);
    this.events = new VegaEventBus<VegaEventMap>();
    this.plugins = new VegaPluginHost(this.lifetime.child("plugins"), this.events);
    this.portsLifetime = this.lifetime.child("ports");
    this.portsLifetime.defer(() => this.volatileStorage.clear());
    this.storage = Object.freeze({
      get: <T = unknown>(key: string, signal?: AbortSignal) => this.readStorage<T>(key, signal),
      set: (key: string, value: unknown, signal?: AbortSignal) => this.writeStorage(key, value, signal),
      delete: (key: string, signal?: AbortSignal) => this.deleteStorage(key, signal),
    });
    this.initialization = this.initializePlugins(options);
    // Constructor work must never become an unhandled rejection. `start`
    // still observes and rethrows the original initialization failure.
    void this.initialization.catch(() => undefined);
  }

  get phase(): VegaEnginePhase {
    return this.phaseValue;
  }

  get ready(): boolean {
    return this.phaseValue === "ready";
  }

  onInput(handler: VegaInputHandler): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("Vega input handler must be a function");
    }
    return this.events.on("input", handler);
  }

  install(plugin: VegaPlugin): Promise<this> {
    return this.schedulePluginInstall(plugin, "third-party").then(() => this);
  }

  installOfficial(plugin: VegaPlugin): Promise<this> {
    return this.schedulePluginInstall(plugin, "official").then(() => this);
  }

  start(): Promise<this> {
    if (this.startPromise) return this.startPromise;
    if (this.phaseValue !== "created") {
      return Promise.reject(new ReferenceError(`Vega engine ${this.id} cannot start while ${this.phaseValue}`));
    }
    this.phaseValue = "starting";
    this.startPromise = (async () => {
      await this.initialization;
      while (this.pendingPluginInstalls.size) {
        await Promise.all([...this.pendingPluginInstalls]);
      }
      if (this.phaseValue !== "starting") {
        throw new ReferenceError(`Vega engine ${this.id} was disposed while starting`);
      }
      this.connectInputContributions();
      await this.events.emit("engine:ready", { engineId: this.id });
      this.phaseValue = "ready";
      return this;
    })().catch(async (error) => {
      if (this.phaseValue === "starting") this.phaseValue = "failed";
      try {
        await this.portsLifetime.dispose();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Vega engine ${this.id} failed to start and release its host ports`,
        );
      }
      throw error;
    });
    void this.startPromise.catch(() => undefined);
    return this.startPromise;
  }

  async createPlayer(options: VegaPlayerOptions): Promise<VegaPlayerHandle> {
    await this.start();
    if (this.phaseValue !== "ready") {
      throw new ReferenceError(`Vega engine ${this.id} cannot create a player while ${this.phaseValue}`);
    }
    const id = `${this.id}/player-${++playerSequence}`;
    const lifetime = this.lifetime.child(`players/player-${playerSequence}`);
    const state = options.state ?? createVegaPlayerState();
    const narrativeStore = options.narrativeStore ?? new VegaNarrativeStore();
    const commandExtensions = [...this.plugins.commandExtensions.values()].map(
      ({ opcode, commandType, execute, authority, replaySafe, prepareStoryResources, enumerateCommandResources }) => ({
        opcode,
        commandType,
        execute,
        authority,
        replaySafe,
        prepareStoryResources,
        enumerateCommandResources,
      }),
    );
    const resources = new DefaultStoryResourceResolver(this.plugins.contributions("resource"));
    let presentation: VegaPlayerPresentation | undefined;
    let player: AdvPlayer | undefined;
    let sceneBackend: StorySceneBackend | undefined;
    let shell: VegaManagedShellController | VegaShellController | undefined;
    try {
      presentation = createVegaPlayerPresentation({
        engineId: this.id,
        playerId: id,
        mount: options.mount,
        lifetime,
        themes: this.plugins.contributions("theme"),
        theme: options.theme,
        uiSlots: this.plugins.contributions("ui-slot"),
      });
      const renderContribution = selectVegaRenderContribution(
        this.plugins.contributions("render"),
        options.renderBackend,
      );
      const characterProviders = this.plugins.contributions("character");
      if (renderContribution) {
        const rendererExtensions: StoryRendererExtensionRegistry = Object.freeze({
          effects: Object.freeze([...this.plugins.contributions("effect")]),
          service: <T>(key: StoryRendererServiceKey<T>) => this.plugins.service(key),
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
      player = new AdvPlayer({
        mount: presentation.stage,
        story: options.story,
        resolveLocalizedText: options.resolveLocalizedText,
        state,
        commandExtensions,
        sceneBackend,
        resources,
        narrativeStore,
        narrativeInput: options.narrativeInput ?? browserInput?.provider,
        characterProviders,
        resourcePreparers: presentation.theme ? [presentation.theme] : [],
      });
      const constructedPlayer = player;
      lifetime.defer(() => constructedPlayer.dispose({ releaseTextures: true }));
      const playerServices = playerServiceMap(options.services);
      const configuredShell = playerServices.get(VEGA_SHELL_CONTROLLER.id) as VegaShellController | undefined;
      const engineShell = this.plugins.service(VEGA_SHELL_CONTROLLER);
      const uiRequiresShell = this.plugins
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
            shellOptions.storage ?? (this.defaultSaveStorage ??= browserSaveStorage() ?? new VegaMemorySaveStorage()),
          projectId: shellOptions.projectId,
          settingsId: shellOptions.settingsId,
          initialSettings: shellOptions.initialSettings,
          title: shellOptions.title,
          initialScreen: shellOptions.initialScreen,
          root: presentation.root,
          signal: lifetime.signal,
          onExitRequest: async () => {
            await shellOptions.onExitRequest?.();
            await this.events.emit("shell:exit-request", { engineId: this.id, playerId: id });
          },
        });
        lifetime.use(shell);
        playerServices.set(VEGA_SHELL_CONTROLLER.id, shell);
      }
      await mountVegaUiSlots({
        resources,
        contributions: this.plugins.contributions("ui-slot"),
        presentation,
        lifetime,
        engineId: this.id,
        playerId: id,
        player: constructedPlayer,
        state,
        service: (key) =>
          playerServices.has(key.id) ? (playerServices.get(key.id) as never) : this.plugins.service(key),
      });
      await constructedPlayer.boot();
    } catch (error) {
      if (!player && sceneBackend) await sceneBackend.destroy({ releaseTextures: true });
      await lifetime.dispose().catch(() => undefined);
      throw error;
    }
    if (!player) throw new Error("Vega player construction completed without a player");
    if (!presentation) throw new Error("Vega player construction completed without a presentation");

    const active: ActivePlayer = { id, lifetime, disposal: null };
    this.activePlayers.set(id, active);
    const handle: VegaPlayerHandle = {
      id,
      player,
      lifetime,
      root: presentation.root,
      slots: presentation.slots,
      ...(shell ? { shell } : {}),
      dispose: () => this.disposePlayer(active),
    };
    try {
      await this.events.emit("player:create", { playerId: id });
      return handle;
    } catch (error) {
      await this.disposePlayer(active).catch(() => undefined);
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.phaseValue === "disposed") return Promise.resolve();
    this.phaseValue = "disposing";
    this.disposal = (async () => {
      const errors: unknown[] = [];
      await this.initialization.catch((error) => errors.push(error));
      await Promise.allSettled([...this.pendingPluginInstalls]);
      try {
        await this.events.emit("engine:dispose", { engineId: this.id });
      } catch (error) {
        errors.push(error);
      }
      for (const player of [...this.activePlayers.values()].reverse()) {
        try {
          await this.disposePlayer(player);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.portsLifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.inputDispatchTail;
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.plugins.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
      this.events.clear();
      this.phaseValue = "disposed";
      if (errors.length) throw new AggregateError(errors, `Failed to dispose Vega engine ${this.id}`);
    })();
    return this.disposal;
  }

  private async initializePlugins(options: VegaEngineOptions): Promise<void> {
    for (const plugin of options.officialPlugins ?? []) await this.plugins.installOfficial(plugin);
    for (const plugin of options.plugins ?? []) await this.plugins.install(plugin);
  }

  private schedulePluginInstall(plugin: VegaPlugin, authority: "official" | "third-party"): Promise<void> {
    if (this.phaseValue !== "created") {
      return Promise.reject(
        new ReferenceError(`Vega plugins must be installed before engine start; ${this.id} is ${this.phaseValue}`),
      );
    }
    const operation = this.initialization.then(() =>
      authority === "official" ? this.plugins.installOfficial(plugin) : this.plugins.install(plugin),
    );
    this.pendingPluginInstalls.add(operation);
    void operation.then(
      () => this.pendingPluginInstalls.delete(operation),
      () => this.pendingPluginInstalls.delete(operation),
    );
    return operation;
  }

  private connectInputContributions(): void {
    for (const selection of this.plugins.contributionSelections("input")) {
      if (!selection.active) continue;
      const source = `${selection.owner}:${selection.contribution.id}`;
      const subscription = selection.contribution.subscribe(
        (event) => this.enqueueInput(event, source),
        this.portsLifetime.signal,
      );
      this.portsLifetime.use(subscription);
    }
  }

  private enqueueInput(candidate: VegaInputEvent, fallbackSource: string): void {
    if (this.portsLifetime.signal.aborted) return;
    let event: VegaInputEvent;
    try {
      event = normalizeInputEvent(candidate, fallbackSource);
    } catch (error) {
      void this.reportInputDiagnostic("input-event-invalid", errorMessage(error), fallbackSource);
      return;
    }
    const dispatch = this.inputDispatchTail.then(async () => {
      if (this.portsLifetime.signal.aborted) return;
      try {
        await this.events.emit("input", event);
      } catch (error) {
        await this.reportInputDiagnostic("input-handler-failed", errorMessage(error), event.source);
      }
    });
    this.inputDispatchTail = dispatch.catch(() => undefined);
  }

  private async reportInputDiagnostic(code: string, message: string, source?: string): Promise<void> {
    try {
      await this.events.emit("diagnostic", {
        level: "warning",
        code,
        message,
        ...(source ? { source } : {}),
      });
    } catch {
      // Diagnostics must not break input delivery or engine disposal.
    }
  }

  private readStorage<T>(key: string, signal: AbortSignal | undefined): Promise<T | undefined> {
    return this.withStorage(
      key,
      signal,
      (storage, operationSignal) => storage.get(key, operationSignal) as Promise<T | undefined>,
      () => this.volatileStorage.get(key) as T | undefined,
    );
  }

  private writeStorage(key: string, value: unknown, signal: AbortSignal | undefined): Promise<void> {
    return this.withStorage(
      key,
      signal,
      (storage, operationSignal) => storage.set(key, value, operationSignal),
      () => {
        this.volatileStorage.set(key, value);
      },
    );
  }

  private deleteStorage(key: string, signal: AbortSignal | undefined): Promise<void> {
    return this.withStorage(
      key,
      signal,
      (storage, operationSignal) => storage.delete(key, operationSignal),
      () => {
        this.volatileStorage.delete(key);
      },
    );
  }

  private async withStorage<T>(
    key: string,
    callerSignal: AbortSignal | undefined,
    run: (storage: VegaStorageContribution, signal: AbortSignal) => Promise<T>,
    fallback: () => T,
  ): Promise<T> {
    requireStorageKey(key);
    if (this.phaseValue === "disposing" || this.phaseValue === "disposed") {
      throw new ReferenceError(`Vega engine ${this.id} cannot access storage while ${this.phaseValue}`);
    }
    const linked = linkAbortSignals([this.portsLifetime.signal, callerSignal]);
    try {
      throwIfAborted(linked.signal);
      await settleWithAbort(this.start(), linked.signal);
      if (this.phaseValue !== "ready") {
        throw new ReferenceError(`Vega engine ${this.id} cannot access storage while ${this.phaseValue}`);
      }
      throwIfAborted(linked.signal);
      const storage = this.selectStorageContribution();
      if (!storage) return fallback();
      return await settleWithAbort(run(storage, linked.signal), linked.signal);
    } finally {
      linked.dispose();
    }
  }

  private selectStorageContribution(): VegaStorageContribution | undefined {
    const active = this.plugins.contributionSelections("storage").filter(({ active }) => active);
    const explicit = active.filter(({ singletonPort }) => singletonPort === VEGA_STORAGE_PORT);
    const compatible = explicit.length ? explicit : active.filter(({ singletonPort }) => singletonPort === undefined);
    return [...compatible].sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }
      return stableText(`${left.owner}:${left.contribution.id}`, `${right.owner}:${right.contribution.id}`);
    })[0]?.contribution;
  }

  private disposePlayer(player: ActivePlayer): Promise<void> {
    if (player.disposal) return player.disposal;
    player.disposal = (async () => {
      this.activePlayers.delete(player.id);
      const errors: unknown[] = [];
      try {
        await player.lifetime.dispose();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.events.emit("player:dispose", { playerId: player.id });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, `Failed to dispose Vega player ${player.id}`);
    })();
    return player.disposal;
  }
}

const normalizeInputEvent = (candidate: unknown, fallbackSource: string): VegaInputEvent => {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("Vega input contribution emitted a non-object event");
  }
  const input = candidate as Partial<VegaInputEvent>;
  if (typeof input.action !== "string" || !input.action.trim()) {
    throw new TypeError("Vega input event action must not be empty");
  }
  if (
    input.value !== undefined &&
    !(
      typeof input.value === "string" ||
      typeof input.value === "boolean" ||
      (typeof input.value === "number" && Number.isFinite(input.value))
    )
  ) {
    throw new TypeError("Vega input event value must be a string, boolean, or finite number");
  }
  if (input.source !== undefined && (typeof input.source !== "string" || !input.source.trim())) {
    throw new TypeError("Vega input event source must not be empty");
  }
  return Object.freeze({
    action: input.action.trim(),
    ...(input.value !== undefined ? { value: input.value } : {}),
    source: input.source?.trim() || fallbackSource,
  });
};

const requireStorageKey = (key: string): void => {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("Vega storage key must not be empty");
  }
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const stableText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The Vega operation was aborted", "AbortError");

const settleWithAbort = <T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const linkAbortSignals = (
  signals: readonly (AbortSignal | undefined)[],
): { readonly signal: AbortSignal; dispose(): void } => {
  const controller = new AbortController();
  const listeners: Array<readonly [AbortSignal, () => void]> = [];
  const dispose = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.length = 0;
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      dispose();
      break;
    }
    const listener = () => {
      if (!controller.signal.aborted) {
        controller.abort(abortReason(signal));
      }
      dispose();
    };
    listeners.push([signal, listener]);
    signal.addEventListener("abort", listener, { once: true });
  }
  return { signal: controller.signal, dispose };
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

export const createVega = (options?: VegaEngineOptions): VegaEngine => new VegaEngine(options);

export const createVegaPlayerState = (): AdvPlayerState => ({
  loading: false,
  ready: false,
  playing: false,
  finished: false,
  seeking: false,
  paused: false,
  autoPlay: false,
  fastForward: false,
  instantText: false,
  error: "",
  commandIndex: 0,
  commandCount: 0,
  currentCommand: null,
  viewport: { x: 0, y: 0, width: 1, height: 1, surfaceWidth: 1, surfaceHeight: 1 },
  session: null,
  pluginState: {},
  stage: null,
  background: null,
  still: null,
  frame: null,
  frameName: "",
  frameOpacity: 0,
  frameSlide: 1,
  frameEntries: {},
  stageEnv: { all: 0, light: 0, effect: 0, postEffect: 0, focusPosition: 0 },
  postEffect: null,
  dofActive: false,
  effect: null,
  cover: { color: "#000000", opacity: 0 },
  talk: {
    presentation: "default",
    instantReveal: true,
    enabled: true,
    visible: false,
    speaker: "",
    text: "",
    displayedText: "",
    textComplete: true,
    targetName: "",
    window: "default",
    shakeX: 0,
    shakeY: 0,
  },
  title: { visible: false, text: "", duration: 0 },
  location: { visible: false, text: "" },
  subtitles: { visible: false, text: "", lastText: "" },
  chat: {
    visible: false,
    title: "",
    messages: [],
    typing: "",
    readVisible: false,
    screenMode: 0,
    battery: 100,
    batteryText: "100%",
    chatId: 0,
    participants: "",
    windowKey: "",
    memoryId: "",
    windowAssetName: "",
    dataRoot: "",
    iconAssetName: "",
    group: false,
  },
  choices: { visible: false, items: [] },
  video: {
    visible: false,
    src: "",
    alpha: 1,
    playbackRate: 1,
    playing: false,
    ended: false,
    currentTime: 0,
    duration: 0,
    progress: 0,
  },
  audio: { bgm: "", se: "", voice: "" },
  preload: { done: 0, total: 0, label: "", failures: [] },
  talkLog: [],
  unknownCommands: [],
  unsupported: [],
});

export type VegaCommandRegistration = { readonly opcode: number; readonly execute: AdvCommandExecutor };
