<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { AdvPlayer } from "../core/AdvPlayer";
import { mergeAdvRuntime } from "../core/AdvConstants";
import { createVegaPlayerState } from "../engine/VegaEngine";
import {
  resolveVegaOfficialPlayerPlugins,
  type VegaOfficialPlayerPluginPreset,
} from "../engine/playerPluginPreset";
import {
  createVegaPlayerPresentation,
  isVegaUiSlotEventTarget,
  mountVegaUiSlots,
} from "../engine/playerPresentation";
import type {
  VegaInputEvent,
  VegaPlugin,
  VegaServiceKey,
} from "../engine/plugins";
import { VegaNarrativeStore } from "../narrative/state";
import {
  VegaLocalStorageSaveStorage,
  VegaMemorySaveStorage,
  type VegaSaveStorage,
} from "../narrative/save";
import type { StorySceneBackend } from "../rendering/StorySceneBackend";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import type { StoryResourceScope } from "../runtime";
import { createVegaShellController } from "../shell/controller";
import {
  VEGA_SHELL_CONTROLLER,
  type VegaShellController,
} from "../shell/contracts";
import type {
  AdvChoiceRecord,
  AdvPlayerState,
  AdvStory,
  StoryUiSprites,
} from "../types/AdvRuntime";

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
const canStart = computed(
  () => state.ready && !state.playing && !state.finished,
);
const canReplay = computed(
  () => state.ready && !state.playing && state.finished,
);
const progressLabel = computed(() =>
  state.commandCount
    ? `${Math.min(state.commandIndex, state.commandCount)} / ${state.commandCount}`
    : "",
);
const progress = computed(() => ({
  visible: Boolean(state.ready && state.commandCount),
  label: progressLabel.value,
  ratio: state.commandCount
    ? clamp01(Number(state.commandIndex) / Number(state.commandCount))
    : 0,
  seeking: state.seeking,
  videoVisible: state.video.visible,
  canStart: canStart.value,
  canReplay: canReplay.value,
  playing: state.playing,
}));
const showCoreFault = computed(
  () => Boolean(state.error) && activePluginUiSlots.value.size === 0,
);
const resourceScopeId = computed(() =>
  String(props.resourceScope?.id || "").trim(),
);

let player: AdvPlayer | null = null;
let playerPluginPreset: VegaOfficialPlayerPluginPreset | null = null;
let progressSeekTimer: ReturnType<typeof setTimeout> | null = null;
let progressSeekVersion = 0;
let currentBootCacheKey = "";
let bootGeneration = 0;
let bootController: AbortController | null = null;
let componentUnmounted = false;
const seekDecisionHistory = new Map<number, AdvChoiceRecord>();
const warmedStoryKeys = new Set<string>();
const portableResources = new DefaultStoryResourceResolver();
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
    private readonly storage: NonNullable<
      VegaOfficialPlayerPluginPreset["storageContribution"]
    >,
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
    return (await this.readIndex())
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  private async readIndex(): Promise<string[]> {
    const value = await this.storage.get(
      PLUGIN_SAVE_INDEX_KEY,
      this.preset.lifetime.signal,
    );
    if (!Array.isArray(value)) return [];
    return value.filter((key): key is string => typeof key === "string");
  }

  private writeIndex(keys: ReadonlySet<string>): Promise<void> {
    return this.storage.set(
      PLUGIN_SAVE_INDEX_KEY,
      [...keys].sort(),
      this.preset.lifetime.signal,
    );
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.catch(() => undefined);
    return result;
  }
}

const storyCacheKey = (value: AdvStory | undefined | null): string => {
  if (!value) return "";
  const authored =
    value.storyKey ||
    value.storyId ||
    value.id ||
    value.advId ||
    value.scriptAsset;
  if (authored != null && String(authored)) return String(authored);
  let key = anonymousStoryKeys.get(value);
  if (!key) {
    key = `anonymous-story-${++anonymousStorySequence}`;
    anonymousStoryKeys.set(value, key);
  }
  return key;
};

const preloadCacheKey = (value: AdvStory | undefined | null): string => {
  const key = storyCacheKey(value);
  return key ? `${resourceScopeId.value}\u0000${key}` : "";
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

const saveStorageForPreset = (
  preset: VegaOfficialPlayerPluginPreset,
): VegaSaveStorage => {
  if (preset.storageContribution) {
    return new PluginContributionSaveStorage(
      preset,
      preset.storageContribution,
    );
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

const requiresShellController = (
  preset: VegaOfficialPlayerPluginPreset,
): boolean =>
  preset.uiSlots.some((contribution) =>
    contribution.requiredServices?.some(
      ({ id }) => id === VEGA_SHELL_CONTROLLER.id,
    ),
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
    throw new AggregateError(
      errors,
      "Failed to dispose the framework player and its plugin preset",
    );
  }
}

function handlePluginInput(
  event: VegaInputEvent,
  current: AdvPlayer,
  shell?: VegaShellController,
): void {
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

async function boot(
  options: { reusePreload?: boolean } = {},
  attempt: BootAttempt = beginBootAttempt(),
): Promise<AdvPlayer | null> {
  const mount = stageHost.value;
  const storyValue = story.value;
  if (!mount || !storyValue || !isBootAttemptActive(attempt)) return null;

  let current: AdvPlayer | null = null;
  let unownedSceneBackend: StorySceneBackend | null = null;
  let unownedPluginPreset: VegaOfficialPlayerPluginPreset | null = null;
  let ownedPluginPreset: VegaOfficialPlayerPluginPreset | null = null;
  try {
    const cacheKey = preloadCacheKey(storyValue);
    const skipPreload = Boolean(
      options.reusePreload && cacheKey && warmedStoryKeys.has(cacheKey),
    );
    state.instantText = props.instantText === 0;

    unownedPluginPreset = await resolveVegaOfficialPlayerPlugins({
      plugins: props.officialPlugins ?? [],
      renderBackend: props.renderBackend,
      signal: attempt.controller.signal,
    });
    if (!isBootAttemptActive(attempt)) {
      await unownedPluginPreset.dispose();
      return null;
    }

    const activeResources =
      props.officialPlugins === undefined
        ? portableResources
        : unownedPluginPreset.resources;
    const presentationLifetime = unownedPluginPreset.lifetime.child(
      `presentation-${attempt.generation}`,
    );
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
        throw new TypeError(
          `Vega render contribution ${renderContribution.id} did not create a scene backend`,
        );
      }
    }
    if (!isBootAttemptActive(attempt)) {
      await unownedSceneBackend?.destroy({ releaseTextures: true });
      unownedSceneBackend = null;
      await unownedPluginPreset.dispose();
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
    });
    unownedSceneBackend = null;
    if (!isBootAttemptActive(attempt)) {
      await disposePlayerInstance(current, unownedPluginPreset, true);
      unownedPluginPreset = null;
      return null;
    }

    player = current;
    ownedPluginPreset = unownedPluginPreset;
    playerPluginPreset = ownedPluginPreset;
    unownedPluginPreset = null;
    currentBootCacheKey = cacheKey;
    syncPlayerAudioSettings();
    syncPlayerAutoPlay();
    syncPlayerSubtitlesSettings();
    const debugHost = globalThis as unknown as Record<string, unknown>;
    debugHost.__advState = state;
    debugHost.__advPlayer = current;

    const contributedShell = ownedPluginPreset.service(
      VEGA_SHELL_CONTROLLER,
    );
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
    shell?.enterGame();
    if (shell && !contributedShell) presentationLifetime.use(shell);
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
        playerServices.has(key.id)
          ? (playerServices.get(key.id) as T)
          : ownedPluginPreset?.service(key),
    });
    for (const input of ownedPluginPreset.inputContributions) {
      presentationLifetime.use(
        input.subscribe(
          (event) => handlePluginInput(event, current!, shell),
          presentationLifetime.signal,
        ),
      );
    }
    activePluginUiSlots.value = new Set(
      ownedPluginPreset.uiSlots.map(({ slot }) => slot),
    );
    await current.boot({ skipPreload });

    if (!isBootAttemptActive(attempt) || player !== current) {
      if (player === current) clearOwnedPlayer(current, ownedPluginPreset);
      await disposePlayerInstance(current, ownedPluginPreset, true);
      return null;
    }
    if (cacheKey) warmedStoryKeys.add(cacheKey);
    return current;
  } catch (error: unknown) {
    try {
      await unownedSceneBackend?.destroy({ releaseTextures: true });
    } catch (cleanupError) {
      console.error(
        "[Vega] failed to dispose an unowned scene backend",
        cleanupError,
      );
    }
    try {
      await disposePlayerInstance(
        current,
        unownedPluginPreset ?? ownedPluginPreset,
        true,
      );
    } catch (cleanupError) {
      console.error(
        "[Vega] failed to dispose an aborted framework player",
        cleanupError,
      );
    }
    if (player === current) clearOwnedPlayer(current, ownedPluginPreset);
    if (!isBootAttemptActive(attempt) || attempt.controller.signal.aborted) {
      return null;
    }
    state.error = error instanceof Error ? error.message : String(error);
    state.loading = false;
    return null;
  }
}

function clearOwnedPlayer(
  current: AdvPlayer | null,
  preset: VegaOfficialPlayerPluginPreset | null,
): void {
  player = null;
  if (playerPluginPreset === preset) playerPluginPreset = null;
  activePluginUiSlots.value = new Set();
  currentBootCacheKey = "";
  const debugHost = globalThis as unknown as Record<string, unknown>;
  if (debugHost.__advPlayer === current) debugHost.__advPlayer = null;
  if (debugHost.__advState === state) debugHost.__advState = null;
}

async function destroy(
  options: { releaseTextures?: boolean } = {},
): Promise<void> {
  invalidateBootAttempt();
  if (progressSeekTimer) {
    clearTimeout(progressSeekTimer);
    progressSeekTimer = null;
  }
  const current = player;
  const preset = playerPluginPreset;
  const cacheKey = currentBootCacheKey;
  clearOwnedPlayer(current, preset);
  await disposePlayerInstance(
    current,
    preset,
    options.releaseTextures !== false,
  );
  if (options.releaseTextures !== false && cacheKey) {
    warmedStoryKeys.delete(cacheKey);
  }
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
  seekDecisionHistory.clear();
  await destroy({ releaseTextures: false });
  const attempt = beginBootAttempt();
  Object.assign(state, createVegaPlayerState());
  await nextTick();
  if (!isBootAttemptActive(attempt)) return;
  const current = await boot({ reusePreload: true }, attempt);
  if (current && isBootAttemptActive(attempt) && player === current) {
    playCurrentPlayer();
  }
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
  const targetIndex = Math.max(
    0,
    Math.min(state.commandCount, Math.round(ratio * state.commandCount)),
  );
  const version = ++progressSeekVersion;
  const current = player;
  for (const [key, value] of current?.exportSeekDecisions() ?? []) {
    seekDecisionHistory.set(key, value);
  }
  await destroy({ releaseTextures: false });
  const attempt = beginBootAttempt();
  Object.assign(state, createVegaPlayerState());
  await nextTick();
  if (!isBootAttemptActive(attempt)) return;
  const restored = await boot({ reusePreload: true }, attempt);
  if (
    version !== progressSeekVersion ||
    !restored ||
    player !== restored ||
    !isBootAttemptActive(attempt)
  ) {
    return;
  }
  restored.importSeekDecisions(seekDecisionHistory);
  await restored.replayFromStartTo(targetIndex);
  if (
    version === progressSeekVersion &&
    player === restored &&
    isBootAttemptActive(attempt)
  ) {
    playCurrentPlayer();
  }
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
  player.SoundManager.setUserCategoryVolume(
    "Bgm",
    props.enableBgm === 0 ? clampVolume(props.volumeBgm) : 0,
  );
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

onMounted(() => void boot());
onBeforeUnmount(() => {
  componentUnmounted = true;
  void destroy({ releaseTextures: true }).catch((error) => {
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
  async () => {
    seekDecisionHistory.clear();
    await destroy({ releaseTextures: true });
    const attempt = beginBootAttempt();
    Object.assign(state, createVegaPlayerState());
    state.instantText = props.instantText === 0;
    await nextTick();
    if (isBootAttemptActive(attempt)) await boot({}, attempt);
  },
);
watch(
  () => props.instantText,
  () => {
    state.instantText = props.instantText === 0;
  },
  { immediate: true },
);
watch(
  () => [props.volume, props.volumeBgm, props.enableBgm],
  syncPlayerAudioSettings,
  { immediate: true },
);
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
  >
    <div
      ref="stageHost"
      class="adv-canvas-host vega-stage-host"
      @click="onStageClick"
    />
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
