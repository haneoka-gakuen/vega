<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { AdvPlayer } from "../core/AdvPlayer";
import { mergeAdvRuntime } from "../core/AdvConstants";
import { createVegaPlayerState } from "../engine/VegaEngine";
import { resolveVegaOfficialPlayerPlugins, type VegaOfficialPlayerPluginPreset } from "../engine/playerPluginPreset";
import { createVegaPlayerPresentation, isVegaUiSlotEventTarget, mountVegaUiSlots } from "../engine/playerPresentation";
import type { VegaInputEvent, VegaPlugin, VegaServiceKey } from "../engine/plugins";
import { VegaNarrativeStore } from "../narrative/state";
import { VegaLocalStorageSaveStorage, VegaMemorySaveStorage, type VegaSaveStorage } from "../narrative/save";
import type { StoryResourceLease, StorySceneBackend } from "../rendering/StorySceneBackend";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import type { StoryResourceScope } from "../runtime";
import { createVegaShellController } from "../shell/controller";
import { VEGA_SHELL_CONTROLLER, type VegaShellController } from "../shell/contracts";
import type { AdvPlayerState, AdvStory, StoryUiSprites } from "../types/AdvRuntime";
import { prepareStoryAudio } from "../sound/StoryAudioPrimer";

defineOptions({ name: "StoryPlayerFull" });

const props = withDefaults(
  defineProps<{
    story?: AdvStory;
    storyData?: AdvStory;
    /**
     * Retained for source compatibility. Game chrome and sprite assets are
     * supplied by explicit UI/theme plugins.
     */
    uiSprites?: StoryUiSprites;
    volume?: number;
    volumeBgm?: number;
    enableBgm?: number;
    autoPlay?: number;
    autoPlayInterval?: number;
    instantText?: number;
    textSize?: number;
    subtitlesEnabled?: boolean;
    resourceScope?: StoryResourceScope;
    /** Retained for source compatibility; progress UI belongs to a plugin. */
    showProgress?: boolean;
    /** Retained for source compatibility; start/replay UI belongs to a plugin. */
    showStart?: boolean;
    /** Trusted plugin preset resolved only for this component instance. */
    officialPlugins?: readonly VegaPlugin[];
    /** Render contribution id or backend name from `officialPlugins`. */
    renderBackend?: string;
    /** Installed theme id. `false` leaves plugin presentation unthemed. */
    theme?: string | false;
  }>(),
  { theme: undefined },
);

const rootEl = ref<HTMLElement | null>(null);
const stageHost = ref<HTMLElement | null>(null);
const state = reactive(createVegaPlayerState());
const story = computed(() => props.storyData ?? props.story);
const runtime = computed(() => mergeAdvRuntime(story.value?.runtime));
const activePluginUiSlots = ref<ReadonlySet<string>>(new Set());
const canStart = computed(() => state.ready && !state.playing && !state.finished);
const canReplay = computed(() => state.ready && !state.playing && state.finished);
const pathProgress = computed(() => {
  // Keep Vue subscribed while the player's path index itself remains an
  // intentionally non-reactive command-boundary cache.
  void state.commandIndex;
  void state.seeking;
  return (
    player?.currentSeekProgress() ?? {
      ratio: 0,
      label: state.commandCount ? "0 / 0" : "",
    }
  );
});
const progress = computed(() => ({
  visible: Boolean(state.ready && state.commandCount),
  label: pathProgress.value.label,
  ratio: pathProgress.value.ratio,
  seeking: state.seeking,
  videoVisible: state.video.visible,
  canStart: canStart.value,
  canReplay: canReplay.value,
  playing: state.playing,
}));
const showCoreFault = computed(() => Boolean(state.error) && activePluginUiSlots.value.size === 0);
const resourceScopeId = computed(() => String(props.resourceScope?.id || "").trim());

let player: AdvPlayer | null = null;
let playerPluginPreset: VegaOfficialPlayerPluginPreset | null = null;
let progressSeekTimer: ReturnType<typeof setTimeout> | null = null;
let bootGeneration = 0;
let bootController: AbortController | null = null;
let componentUnmounted = false;
let playerOperationGeneration = 0;
let playerOperationTail: Promise<void> = Promise.resolve();
let resourceCacheKey: object = {};
let portableResources = new DefaultStoryResourceResolver([], {
  sharedKey: resourceCacheKey,
});
const resourceLeaseHandoff = new Map<string, StoryResourceLease>();
const anonymousStoryKeys = new WeakMap<object, string>();
let anonymousStorySequence = 0;

interface BootAttempt {
  readonly generation: number;
  readonly controller: AbortController;
}

const PLUGIN_SAVE_INDEX_KEY = "vega:save-storage:index";

class PluginContributionSaveStorage implements VegaSaveStorage {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly preset: VegaOfficialPlayerPluginPreset,
    private readonly storage: NonNullable<VegaOfficialPlayerPluginPreset["storageContribution"]>,
  ) {}

  async read(key: string): Promise<string | null> {
    const value = await this.storage.get(key, this.preset.lifetime.signal);
    if (value == null) return null;
    if (typeof value !== "string") {
      throw new TypeError(`Vega save storage entry is not text: ${key}`);
    }
    return value;
  }

  write(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      await this.storage.set(key, value, this.preset.lifetime.signal);
      const keys = new Set(await this.readIndex());
      keys.add(key);
      await this.writeIndex(keys);
    });
  }

  remove(key: string): Promise<void> {
    return this.enqueue(async () => {
      await this.storage.delete(key, this.preset.lifetime.signal);
      const keys = new Set(await this.readIndex());
      keys.delete(key);
      await this.writeIndex(keys);
    });
  }

  async list(prefix: string): Promise<readonly string[]> {
    await this.operationTail;
    return (await this.readIndex()).filter((key) => key.startsWith(prefix)).sort();
  }

  private async readIndex(): Promise<string[]> {
    const value = await this.storage.get(PLUGIN_SAVE_INDEX_KEY, this.preset.lifetime.signal);
    if (!Array.isArray(value)) return [];
    return value.filter((key): key is string => typeof key === "string");
  }

  private writeIndex(keys: ReadonlySet<string>): Promise<void> {
    return this.storage.set(PLUGIN_SAVE_INDEX_KEY, [...keys].sort(), this.preset.lifetime.signal);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.catch(() => undefined);
    return result;
  }
}

const storyCacheKey = (value: AdvStory | undefined | null): string => {
  if (!value) return "";
  const authored = value.storyKey || value.storyId || value.id || value.advId || value.scriptAsset;
  if (authored != null && String(authored)) return String(authored);
  let key = anonymousStoryKeys.get(value);
  if (!key) {
    key = `anonymous-story-${++anonymousStorySequence}`;
    anonymousStoryKeys.set(value, key);
  }
  return key;
};

const resetResourceCache = (): void => {
  resourceCacheKey = {};
  portableResources = new DefaultStoryResourceResolver([], {
    sharedKey: resourceCacheKey,
  });
};

const releaseResourceLeaseHandoff = (): void => {
  for (const lease of resourceLeaseHandoff.values()) lease.release();
  resourceLeaseHandoff.clear();
};

const preserveResourceLeases = (current: AdvPlayer | null): void => {
  if (!current) return;
  for (const [url, lease] of current.Loader.takeResourceLeases()) {
    const existing = resourceLeaseHandoff.get(url);
    if (existing) lease.release();
    else resourceLeaseHandoff.set(url, lease);
  }
};

const beginBootAttempt = (): BootAttempt => {
  bootController?.abort();
  const controller = new AbortController();
  bootController = controller;
  return { generation: ++bootGeneration, controller };
};

const isBootAttemptActive = (attempt: BootAttempt): boolean =>
  !componentUnmounted &&
  !attempt.controller.signal.aborted &&
  attempt.generation === bootGeneration &&
  bootController === attempt.controller;

const invalidateBootAttempt = (): void => {
  bootGeneration += 1;
  bootController?.abort();
  bootController = null;
};

const isPlayerOperationActive = (generation: number): boolean =>
  !componentUnmounted && generation === playerOperationGeneration;

const enqueuePlayerOperation = (
  operation: (generation: number) => Promise<void>,
  options: { cancelBoot?: boolean } = {},
): Promise<void> => {
  if (componentUnmounted) return Promise.resolve();
  const generation = ++playerOperationGeneration;
  // Cancel an active boot immediately. The serialized operation waits for its
  // cleanup before it mutates ownership, preventing an older restart/seek from
  // becoming current again after a newer request (the async ABA case).
  if (options.cancelBoot !== false) invalidateBootAttempt();
  if (progressSeekTimer) {
    clearTimeout(progressSeekTimer);
    progressSeekTimer = null;
  }
  const queued = playerOperationTail
    .catch(() => undefined)
    .then(async () => {
      if (!isPlayerOperationActive(generation)) return;
      await operation(generation);
    });
  const result = queued.catch((error: unknown) => {
    // Superseded operations must not surface stale failures into the current
    // player's UI. The operation that is still current keeps normal errors.
    if (!isPlayerOperationActive(generation)) return;
    throw error;
  });
  playerOperationTail = result.catch(() => undefined);
  return result;
};

const saveStorageForPreset = (preset: VegaOfficialPlayerPluginPreset): VegaSaveStorage => {
  if (preset.storageContribution) {
    return new PluginContributionSaveStorage(preset, preset.storageContribution);
  }
  try {
    if (globalThis.localStorage) {
      return new VegaLocalStorageSaveStorage(globalThis.localStorage);
    }
  } catch {
    // Sandboxed documents may deny localStorage access.
  }
  return new VegaMemorySaveStorage();
};

const requiresShellController = (preset: VegaOfficialPlayerPluginPreset): boolean =>
  preset.uiSlots.some((contribution) =>
    contribution.requiredServices?.some(({ id }) => id === VEGA_SHELL_CONTROLLER.id),
  );

async function disposePlayerInstance(
  current: AdvPlayer | null,
  preset: VegaOfficialPlayerPluginPreset | null,
  releaseTextures: boolean,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await current?.dispose({ releaseTextures });
  } catch (error) {
    errors.push(error);
  }
  try {
    await preset?.dispose();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Failed to dispose the framework player and its plugin preset");
  }
}

function handlePluginInput(event: VegaInputEvent, current: AdvPlayer, shell?: VegaShellController): void {
  if (player !== current) return;
  switch (event.action) {
    case "advance":
      startOrAdvance();
      break;
    case "menu":
      if (!shell) break;
      if (shell.snapshot().screen === "game") shell.open("menu");
      else shell.close();
      break;
    case "auto":
      shell?.toggleAuto();
      break;
    case "fast":
      shell?.toggleFastForward();
      break;
    case "pause":
      shell ? shell.pause() : current.pause();
      break;
    case "resume":
      shell ? shell.resume() : current.resume();
      break;
  }
}

function onStageClick(event: MouseEvent): void {
  if (isVegaUiSlotEventTarget(event.target)) return;
  startOrAdvance();
}

async function boot(attempt: BootAttempt): Promise<AdvPlayer | null> {
  const mount = stageHost.value;
  const storyValue = story.value;
  if (!mount || !storyValue || !isBootAttemptActive(attempt)) return null;

  let current: AdvPlayer | null = null;
  let unownedSceneBackend: StorySceneBackend | null = null;
  let unownedPluginPreset: VegaOfficialPlayerPluginPreset | null = null;
  let ownedPluginPreset: VegaOfficialPlayerPluginPreset | null = null;
  let playerDisposalClaimed = false;
  const disposeUnownedSceneBackend = async (): Promise<void> => {
    const backend = unownedSceneBackend;
    // Claim ownership before awaiting cleanup. If cleanup itself rejects, the
    // outer catch must not try to destroy the same backend a second time.
    unownedSceneBackend = null;
    await backend?.destroy({ releaseTextures: true });
  };
  const disposeBootPlayer = async (): Promise<void> => {
    if (playerDisposalClaimed) return;
    // AdvPlayer.dispose and preset.dispose may partially succeed before one of
    // them rejects. Treat the pair as claimed before awaiting so neither is
    // invoked twice by the outer catch path.
    playerDisposalClaimed = true;
    await disposePlayerInstance(current, unownedPluginPreset ?? ownedPluginPreset, true);
  };
  try {
    state.instantText = props.instantText === 0;

    unownedPluginPreset = await resolveVegaOfficialPlayerPlugins({
      plugins: props.officialPlugins ?? [],
      renderBackend: props.renderBackend,
      resourceCacheKey,
      signal: attempt.controller.signal,
    });
    if (!isBootAttemptActive(attempt)) {
      await disposeBootPlayer();
      return null;
    }

    const activeResources = props.officialPlugins === undefined ? portableResources : unownedPluginPreset.resources;
    const presentationLifetime = unownedPluginPreset.lifetime.child(`presentation-${attempt.generation}`);
    const presentation = createVegaPlayerPresentation({
      engineId: "vega-vue",
      playerId: `vega-vue/player-${attempt.generation}`,
      mount,
      lifetime: presentationLifetime,
      themes: unownedPluginPreset.themes,
      theme: props.theme,
      uiSlots: unownedPluginPreset.uiSlots,
    });
    const renderContribution = unownedPluginPreset.renderContribution;
    if (renderContribution) {
      unownedSceneBackend = await renderContribution.create(
        {
          runtime: runtime.value,
          state,
          resources: activeResources,
          characterProviders: unownedPluginPreset.characterProviders,
          rendererExtensions: unownedPluginPreset.rendererExtensions,
          signal: attempt.controller.signal,
        },
        attempt.controller.signal,
      );
      if (
        !unownedSceneBackend ||
        typeof unownedSceneBackend.setup !== "function" ||
        typeof unownedSceneBackend.destroy !== "function"
      ) {
        throw new TypeError(`Vega render contribution ${renderContribution.id} did not create a scene backend`);
      }
    }
    if (!isBootAttemptActive(attempt)) {
      await disposeUnownedSceneBackend();
      await disposeBootPlayer();
      return null;
    }

    const narrativeStore = new VegaNarrativeStore();
    current = new AdvPlayer({
      mount: presentation.stage,
      story: storyValue,
      state,
      ...(unownedSceneBackend ? { sceneBackend: unownedSceneBackend } : {}),
      resources: activeResources,
      narrativeStore,
      characterProviders: unownedPluginPreset.characterProviders,
      commandExtensions: unownedPluginPreset.commandExtensions,
      resourcePreparers: presentation.theme ? [presentation.theme] : [],
    });
    unownedSceneBackend = null;
    if (!isBootAttemptActive(attempt)) {
      await disposeBootPlayer();
      return null;
    }

    current.Loader.adoptResourceLeases(resourceLeaseHandoff);
    resourceLeaseHandoff.clear();

    player = current;
    ownedPluginPreset = unownedPluginPreset;
    playerPluginPreset = ownedPluginPreset;
    unownedPluginPreset = null;
    syncPlayerAudioSettings();
    syncPlayerAutoPlay();
    syncPlayerSubtitlesSettings();
    const debugHost = globalThis as unknown as Record<string, unknown>;
    debugHost.__advState = state;
    debugHost.__advPlayer = current;

    const contributedShell = ownedPluginPreset.service(VEGA_SHELL_CONTROLLER);
    const shell =
      contributedShell ??
      (requiresShellController(ownedPluginPreset)
        ? await createVegaShellController({
            player: current,
            story: storyValue,
            narrativeStore,
            storage: saveStorageForPreset(ownedPluginPreset),
            root: presentation.root,
            signal: presentationLifetime.signal,
          })
        : undefined);
    if (shell && !contributedShell) presentationLifetime.use(shell);
    if (!isBootAttemptActive(attempt) || player !== current) {
      if (player === current) clearOwnedPlayer(current, ownedPluginPreset);
      await disposeBootPlayer();
      return null;
    }
    shell?.enterGame();
    const playerServices = new Map<string, unknown>();
    if (shell) playerServices.set(VEGA_SHELL_CONTROLLER.id, shell);

    await mountVegaUiSlots({
      contributions: ownedPluginPreset.uiSlots,
      presentation,
      lifetime: presentationLifetime,
      engineId: "vega-vue",
      playerId: `vega-vue/player-${attempt.generation}`,
      player: current,
      state,
      service: <T,>(key: VegaServiceKey<T>): T | undefined =>
        playerServices.has(key.id) ? (playerServices.get(key.id) as T) : ownedPluginPreset?.service(key),
    });
    if (!isBootAttemptActive(attempt) || player !== current) {
      if (player === current) clearOwnedPlayer(current, ownedPluginPreset);
      await disposeBootPlayer();
      return null;
    }
    for (const input of ownedPluginPreset.inputContributions) {
      presentationLifetime.use(
        input.subscribe((event) => handlePluginInput(event, current!, shell), presentationLifetime.signal),
      );
    }
    activePluginUiSlots.value = new Set(ownedPluginPreset.uiSlots.map(({ slot }) => slot));
    // Progress seeks stay on this player so its renderer-ready episode cache
    // and command-boundary scene index remain valid.
    await current.boot({ signal: attempt.controller.signal });

    if (!isBootAttemptActive(attempt) || player !== current) {
      if (player === current) clearOwnedPlayer(current, ownedPluginPreset);
      await disposeBootPlayer();
      return null;
    }
    return current;
  } catch (error: unknown) {
    try {
      await disposeUnownedSceneBackend();
    } catch (cleanupError) {
      console.error("[Vega] failed to dispose an unowned scene backend", cleanupError);
    }
    try {
      await disposeBootPlayer();
    } catch (cleanupError) {
      console.error("[Vega] failed to dispose an aborted framework player", cleanupError);
    }
    if (player === current) clearOwnedPlayer(current, ownedPluginPreset);
    if (!isBootAttemptActive(attempt) || attempt.controller.signal.aborted) {
      return null;
    }
    // A restart/seek may have detached animation leases from the previous
    // player before plugin or renderer creation fails. With no superseding
    // operation and no new player to own them, this terminal failure must
    // release the handoff explicitly.
    releaseResourceLeaseHandoff();
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
    return null;
  }
}

function clearOwnedPlayer(current: AdvPlayer | null, preset: VegaOfficialPlayerPluginPreset | null): void {
  if (player !== current) return;
  player = null;
  if (playerPluginPreset === preset) playerPluginPreset = null;
  activePluginUiSlots.value = new Set();
  const debugHost = globalThis as unknown as Record<string, unknown>;
  if (debugHost.__advPlayer === current) debugHost.__advPlayer = null;
  if (debugHost.__advState === state) debugHost.__advState = null;
}

async function destroy(options: { releaseTextures?: boolean } = {}): Promise<void> {
  invalidateBootAttempt();
  if (progressSeekTimer) {
    clearTimeout(progressSeekTimer);
    progressSeekTimer = null;
  }
  const current = player;
  const preset = playerPluginPreset;
  const preserveLeases = options.releaseTextures === false;
  if (preserveLeases) preserveResourceLeases(current);
  else releaseResourceLeaseHandoff();
  clearOwnedPlayer(current, preset);
  await disposePlayerInstance(current, preset, options.releaseTextures !== false);
}

function playCurrentPlayer(): void {
  const current = player;
  if (!current) return;
  void current.play().catch((error: unknown) => {
    if (player !== current) return;
    state.error = error instanceof Error ? error.message : String(error);
    state.playing = false;
  });
}

function startOrAdvance(): void {
  prepareStoryAudio();
  if (!player || state.loading) return;
  if (canStart.value) {
    playCurrentPlayer();
    return;
  }
  if (canReplay.value) {
    void restart().catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
    });
    return;
  }
  if (state.playing) player.requestNext();
}

async function restart(): Promise<void> {
  return enqueuePlayerOperation(async (generation) => {
    await destroy({ releaseTextures: false });
    if (!isPlayerOperationActive(generation)) return;
    Object.assign(state, createVegaPlayerState());
    await nextTick();
    if (!isPlayerOperationActive(generation)) return;
    const attempt = beginBootAttempt();
    const current = await boot(attempt);
    if (isPlayerOperationActive(generation) && current && isBootAttemptActive(attempt) && player === current) {
      playCurrentPlayer();
    }
  });
}

function seekProgress(ratio: number, delayMs = 0): void {
  if (state.loading || !state.commandCount) return;
  if (progressSeekTimer) clearTimeout(progressSeekTimer);
  progressSeekTimer = setTimeout(
    () => {
      progressSeekTimer = null;
      void seekStoryProgress(clamp01(ratio)).catch((error: unknown) => {
        state.seeking = false;
        state.error = error instanceof Error ? error.message : String(error);
      });
    },
    Math.max(0, delayMs),
  );
}

async function seekStoryProgress(ratio: number): Promise<void> {
  if (!story.value || !state.commandCount) return;
  const current = player;
  if (!current) return;
  const targetIndex = current.resolveSeekRatio(clamp01(ratio));
  await current.seekTo(targetIndex);
}

function resize(): void {
  player?.resize();
}

function skipCurrentVideo(event?: Event): void {
  event?.preventDefault();
  if (state.video.visible) player?.skip();
}

async function toggleFullscreen(): Promise<void> {
  const element = rootEl.value;
  if (!element) return;
  if (document.fullscreenElement) await document.exitFullscreen?.();
  else await element.requestFullscreen?.();
}

const clamp01 = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
};

const clampVolume = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
};

function syncPlayerAudioSettings(): void {
  if (!player?.SoundManager) return;
  player.SoundManager.setMasterVolume(clampVolume(props.volume));
  player.SoundManager.setUserCategoryVolume("Bgm", props.enableBgm === 0 ? clampVolume(props.volumeBgm) : 0);
}

function syncPlayerAutoPlay(): void {
  if (!player?.Model) return;
  player.setAutoPlayInterval(props.autoPlayInterval);
  player.Model.isAutoPlay = props.autoPlay === 0;
  state.autoPlay = player.Model.isAutoPlay;
  if (!player.Model.isAutoPlay) player.cancelAutoAdvance();
  if (player.Model.isAutoPlay && player.Model.NextStepState === 1) {
    player.Model.changeGoNextState();
  }
}

function syncPlayerSubtitlesSettings(): void {
  player?.setSubtitlesEnabled(props.subtitlesEnabled !== false);
}

onMounted(() => {
  void enqueuePlayerOperation(async (generation) => {
    if (!isPlayerOperationActive(generation)) return;
    const attempt = beginBootAttempt();
    await boot(attempt);
  }).catch((error: unknown) => {
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
  });
});
onBeforeUnmount(() => {
  componentUnmounted = true;
  playerOperationGeneration += 1;
  invalidateBootAttempt();
  if (progressSeekTimer) {
    clearTimeout(progressSeekTimer);
    progressSeekTimer = null;
  }
  const cleanup = playerOperationTail.catch(() => undefined).then(() => destroy({ releaseTextures: true }));
  playerOperationTail = cleanup.catch(() => undefined);
  void cleanup.catch((error) => {
    console.error("[Vega] failed to dispose framework player plugins", error);
  });
});

watch(
  () =>
    [
      storyCacheKey(story.value),
      resourceScopeId.value,
      props.officialPlugins,
      props.renderBackend,
      props.theme,
    ] as const,
  () => {
    void enqueuePlayerOperation(async (generation) => {
      await destroy({ releaseTextures: true });
      if (!isPlayerOperationActive(generation)) return;
      resetResourceCache();
      Object.assign(state, createVegaPlayerState());
      state.instantText = props.instantText === 0;
      await nextTick();
      if (!isPlayerOperationActive(generation)) return;
      const attempt = beginBootAttempt();
      await boot(attempt);
    }).catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.loading = false;
    });
  },
);
watch(
  () => props.instantText,
  () => {
    state.instantText = props.instantText === 0;
  },
  { immediate: true },
);
watch(() => [props.volume, props.volumeBgm, props.enableBgm], syncPlayerAudioSettings, { immediate: true });
watch(() => [props.autoPlay, props.autoPlayInterval], syncPlayerAutoPlay, {
  immediate: true,
});
watch(() => props.subtitlesEnabled, syncPlayerSubtitlesSettings, {
  immediate: true,
});

defineExpose({
  progress,
  resize,
  startOrAdvance,
  seekProgress,
  skipCurrentVideo,
  toggleFullscreen,
});
</script>

<template>
  <div
    ref="rootEl"
    class="adv-story-browser vega-game"
    :data-vega-loading="state.loading || undefined"
    :data-vega-playing="state.playing || undefined"
    :data-vega-finished="state.finished || undefined"
    @pointerdown.capture="prepareStoryAudio"
    @keydown.capture="prepareStoryAudio"
  >
    <div ref="stageHost" class="adv-canvas-host vega-stage-host" @click="onStageClick" />
    <output v-if="showCoreFault" role="alert" data-vega-runtime-fault>
      {{ state.error }}
    </output>
  </div>
</template>

<style scoped>
.adv-story-browser {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  isolation: isolate;
  container-type: size;
}

.adv-canvas-host,
.adv-canvas-host :deep(canvas) {
  position: absolute;
  inset: 0;
}

.adv-canvas-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
