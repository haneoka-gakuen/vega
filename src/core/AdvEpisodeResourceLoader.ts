import { hasAdvCharacterModel } from "../types/AdvRuntime";
import type {
  AdvCharacterModelEntry,
  AdvCharacterVariant,
  AdvCommand,
  AdvRuleTransitionEntry,
  AdvSoundEntry,
  AdvStory,
} from "../types/AdvRuntime";
import type { AdvSoundCategory, AdvSoundManager } from "../sound/AdvSoundManager";
import type { StoryResourceBackend, StoryResourceLease, StoryResourceResolver } from "../rendering/StorySceneBackend";
import {
  enumerateCharacterProviderResources,
  type StoryCharacterResourceRole,
  type StoryCharacterProvider,
} from "../rendering/StoryCharacterModel";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import {
  collectStoryResourceDeclarations,
  normalizeStoryResourceDeclarations,
  prepareDeclaredStoryFonts,
  prepareStoryCommandResourcePreparers,
  prepareStoryResourcePreparers,
  runtimeStoryResourcePreparer,
  type StoryCommandResourceRegistration,
  type StoryResourceDeclaration,
  type StoryResourcePreparationContext,
  type StoryResourcePreparer,
} from "../resources/StoryResourcePreparation";
import { isCanonicalStoryResourceUrl, requireCanonicalStoryResourceUrl } from "../runtime";
import { advCommandGroupCommands } from "./AdvCommandGroup";
import { splitAdvTargetNames } from "./AdvCommandText";
import { ADV_COMMAND, mergeAdvRuntime } from "./AdvConstants";
import { sortAdvTimelineSignals } from "./AdvPlayableDirector";

interface SharedFetch {
  readonly controller: AbortController;
  pending: Promise<void>;
  settled: boolean;
  waiters: number;
}

const sharedFetchedUrls = new WeakMap<StoryResourceResolver, Map<string, SharedFetch>>();
const MAX_SHARED_FETCH_KEYS = 512;

function resourceRequestError(name: "AbortError", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function throwIfPreloadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw resourceRequestError("AbortError", "ADV preload was aborted");
}

async function runWithConcurrency<Value>(
  values: readonly Value[],
  concurrency: number,
  signal: AbortSignal | undefined,
  visit: (value: Value) => Promise<unknown>,
): Promise<void> {
  throwIfPreloadAborted(signal);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      throwIfPreloadAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      await visit(values[index]!);
    }
  };
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  throwIfPreloadAborted(signal);
}

function waitForSharedFetch(
  shared: SharedFetch,
  fetched: Map<string, SharedFetch>,
  signal: AbortSignal | undefined,
  url: string,
): Promise<void> {
  if (signal?.aborted) {
    if (shared.waiters === 0 && !shared.settled) {
      if (fetched.get(url) === shared) fetched.delete(url);
      void shared.pending.catch(() => undefined);
      shared.controller.abort();
    }
    return Promise.reject(resourceRequestError("AbortError", `Loading was aborted: ${url}`));
  }
  shared.waiters += 1;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      shared.waiters = Math.max(0, shared.waiters - 1);
      if (shared.waiters === 0 && !shared.settled) {
        if (fetched.get(url) === shared) fetched.delete(url);
        shared.controller.abort();
      }
      callback();
    };
    const abort = (): void => finish(() => reject(resourceRequestError("AbortError", `Loading was aborted: ${url}`)));
    signal?.addEventListener("abort", abort, { once: true });
    shared.pending.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

const fetchedUrlsFor = (resources: StoryResourceResolver): Map<string, SharedFetch> => {
  let fetched = sharedFetchedUrls.get(resources);
  if (!fetched) {
    fetched = new Map();
    sharedFetchedUrls.set(resources, fetched);
  }
  return fetched;
};

const rememberSharedFetch = (fetched: Map<string, SharedFetch>, url: string, request: SharedFetch) => {
  fetched.delete(url);
  fetched.set(url, request);
  while (fetched.size > MAX_SHARED_FETCH_KEYS) {
    const oldest = fetched.keys().next().value;
    if (typeof oldest !== "string") break;
    fetched.delete(oldest);
  }
};

type PreloadTask = {
  key: string;
  label: string;
  index: number;
  run: () => Promise<unknown>;
};

interface CharacterAnimationUsage {
  readonly motions: Set<string>;
  readonly expressions: Set<string>;
}

interface CharacterWarmupRequest {
  readonly identity: string;
  readonly target: string;
  readonly index: number;
  readonly command: AdvCommand;
  readonly positionType: number;
  readonly animationUsage: CharacterAnimationUsage;
}

export interface AdvEpisodeResourceSnapshot {
  readonly characterVariants: Array<[string, AdvCharacterVariant]>;
  readonly characterAssetIndices: Array<[string, number]>;
  readonly playbackIndex: number;
}

export interface AdvEpisodeResourceLoaderOptions {
  readonly resolveLocalizedText?: StoryResourcePreparationContext["resolveLocalizedText"];
  readonly resourcePreparers?: readonly StoryResourcePreparer[];
  readonly commandResourcePreparers?: readonly StoryCommandResourceRegistration[];
  readonly document?: Document;
}

export class AdvEpisodeResourceLoader {
  sceneRoot: StoryResourceBackend;
  state: Record<string, unknown>;
  characterVariants: Map<string, AdvCharacterVariant>;
  characterAssetIndices: Map<string, number>;
  backgroundWarm: Promise<void> | null;
  private backgroundTasks: PreloadTask[];
  private backgroundPump: Promise<void> | null;
  private backgroundRepumpRequested: boolean;
  private completedTaskKeys: Set<string>;
  private scheduledTaskKeys: Set<string>;
  private preloadSignal?: AbortSignal;
  private preloadController: AbortController | null;
  private preloadSourceSignal?: AbortSignal;
  private preloadSourceAbort?: () => void;
  private readonly episodeResourceLeases = new Map<string, StoryResourceLease>();
  private backgroundConcurrency: number;
  private playbackIndex: number;
  private readonly resources: StoryResourceResolver;
  private readonly characterProviders: readonly StoryCharacterProvider[];
  private readonly sounds?: Pick<AdvSoundManager, "preloadSound">;
  private readonly resourcePreparers: readonly StoryResourcePreparer[];
  private readonly commandResourcePreparers: readonly StoryCommandResourceRegistration[];
  private readonly ownerDocument?: Document;
  private readonly resolveLocalizedText: StoryResourcePreparationContext["resolveLocalizedText"];
  constructor(
    sceneRoot: StoryResourceBackend,
    state: Record<string, unknown>,
    resources: StoryResourceResolver = new DefaultStoryResourceResolver(),
    characterProviders: readonly StoryCharacterProvider[] = [],
    sounds?: Pick<AdvSoundManager, "preloadSound">,
    options: AdvEpisodeResourceLoaderOptions = {},
  ) {
    this.sceneRoot = sceneRoot;
    this.state = state;
    this.resources = resources;
    this.characterProviders = Object.freeze([...characterProviders]);
    this.sounds = sounds;
    this.resolveLocalizedText = options.resolveLocalizedText;
    this.resourcePreparers = Object.freeze([runtimeStoryResourcePreparer, ...(options.resourcePreparers ?? [])]);
    this.commandResourcePreparers = Object.freeze([...(options.commandResourcePreparers ?? [])]);
    this.ownerDocument = options.document;
    this.characterVariants = new Map<string, AdvCharacterVariant>();
    this.characterAssetIndices = new Map<string, number>();
    this.backgroundWarm = null;
    this.backgroundTasks = [];
    this.backgroundPump = null;
    this.backgroundRepumpRequested = false;
    this.completedTaskKeys = new Set();
    this.scheduledTaskKeys = new Set();
    this.preloadController = null;
    this.backgroundConcurrency = 6;
    this.playbackIndex = 0;
  }

  async preload(story: AdvStory | null | undefined, signal: AbortSignal): Promise<void> {
    // A newly constructed Loader may already own leases handed off by the
    // preceding player during seek/restart. With no active lifetime to cancel,
    // preserve those leases and validate/reuse them during this full scan.
    this.stopEpisodeLifetime(this.preloadController !== null);
    throwIfPreloadAborted(signal);
    const preloadState = this.state.preload as Record<string, unknown> | undefined;
    // Every attempt owns a fresh loading state. In particular, a retry must
    // never inherit completed work or an error from the preceding attempt.
    this.state.error = "";
    if (preloadState) {
      // This phase counts only concrete resource-preparation work. Command
      // boundaries belong to the later seek-index phase and must not be
      // presented as thousands of "resources" on the loading screen.
      preloadState.total = 0;
      preloadState.done = 0;
      preloadState.error = "";
      preloadState.total = preloadProgressValue(preloadState.total) + 1;
      preloadState.failures = [];
      preloadState.label = "resources";
    }
    const controller = new AbortController();
    this.preloadController = controller;
    this.preloadSourceSignal = signal;
    const forwardAbort = (): void => {
      if (this.preloadController !== controller) return;
      this.preloadSourceSignal = undefined;
      this.preloadSourceAbort = undefined;
      controller.abort(signal.reason);
    };
    this.preloadSourceAbort = forwardAbort;
    signal.addEventListener("abort", forwardAbort, { once: true });
    controller.signal.addEventListener("abort", () => this.releaseResourceLeases(), { once: true });
    try {
      await this.preloadEpisode(story, controller.signal);
    } catch (error) {
      // A newer preload may already own the loader after aborting this one.
      // Never let the stale attempt tear down the newer controller or leases.
      if (this.preloadController === controller) {
        this.stopEpisodeLifetime();
      }
      throw error;
    }
  }

  private async preloadEpisode(story: AdvStory | null | undefined, signal: AbortSignal): Promise<void> {
    throwIfPreloadAborted(signal);
    this.preloadSignal = signal;
    const providerSignal = signal;
    assertNestedCanonicalResourceUrls(story);
    const commands = story?.commands || [];
    const animationUsage = collectReferencedCharacterAnimations(commands, story?.runtime?.targetNameSplitKey);
    const supportsRenderReadyCharacters = typeof this.sceneRoot.preloadCharacter === "function";
    const workerCount = preloadConcurrency(story?.runtime?.preloadConcurrency);
    const characterWarmups = supportsRenderReadyCharacters
      ? collectCharacterWarmupRequests(commands, story?.runtime?.targetNameSplitKey)
      : [];
    const textureUrls = new Set<string>();
    const fileUrls = new Map<string, string>();
    const retainedFileUrls = new Set<string>();
    const audioRequests = new Map<string, Array<{ sound: AdvSoundEntry; category: AdvSoundCategory }>>();
    const videoUrls = new Set<string>();
    const firstCmdIndex = new Map<string, number>();
    const noteIndex = (url: string, index: number) => {
      if (!firstCmdIndex.has(url)) firstCmdIndex.set(url, index);
    };
    const addFile = (label: string, url: string, index: number, retainBytes = true) => {
      assertLocalRuntimeUrl(label, url);
      if (!isLocalRuntimeUrl(url)) return;
      fileUrls.set(url, label);
      if (retainBytes) retainedFileUrls.add(url);
      noteIndex(url, index);
    };
    const addTexture = (url: string, index: number) => {
      assertLocalRuntimeUrl("image", url);
      if (!isLocalRuntimeUrl(url)) return;
      textureUrls.add(url);
      fileUrls.set(url, "image");
      noteIndex(url, index);
    };
    const addAudio = (sound: AdvSoundEntry | null | undefined, category: AdvSoundCategory, index: number) => {
      const url = sound?.playableUrl || "";
      addFile(category.toLocaleLowerCase(), url, index, false);
      if (!url || !isLocalRuntimeUrl(url)) return;
      const requests = audioRequests.get(url) || [];
      if (!requests.some((request) => request.category === category)) {
        requests.push({ sound: sound!, category });
        audioRequests.set(url, requests);
      }
    };
    const addVideo = (url: string, index: number) => {
      addFile("video", url, index, false);
      if (url && isLocalRuntimeUrl(url)) videoUrls.add(url);
    };
    let preparationContext: StoryResourcePreparationContext | undefined;
    let declaredResources: readonly StoryResourceDeclaration[] = [];
    if (story) {
      const usedOpcodes = new Set<number>();
      for (const command of commands) {
        for (const nested of commandsIncludingTimelineEpisodes(command)) {
          usedOpcodes.add(Number(nested.command));
        }
      }
      const usedCommandResourcePreparers = this.commandResourcePreparers.filter((registration) =>
        usedOpcodes.has(Number(registration.opcode)),
      );
      preparationContext = {
        ...(this.resolveLocalizedText ? { resolveLocalizedText: this.resolveLocalizedText } : {}),
        story,
        runtime: mergeAdvRuntime(story.runtime),
        resources: this.resources,
        signal: providerSignal,
        ...(this.ownerDocument ? { document: this.ownerDocument } : {}),
      };
      const preparationTasks: PreloadTask[] = [];
      if (this.resourcePreparers.some((preparer) => typeof preparer.prepareStoryResources === "function")) {
        preparationTasks.push({
          key: "prepare:story",
          label: "plugins",
          index: 0,
          run: () => prepareStoryResourcePreparers(this.resourcePreparers, preparationContext!),
        });
      }
      if (usedCommandResourcePreparers.some((preparer) => typeof preparer.prepareStoryResources === "function")) {
        preparationTasks.push({
          key: "prepare:commands",
          label: "plugins",
          index: 0,
          run: () => prepareStoryCommandResourcePreparers(usedCommandResourcePreparers, preparationContext!),
        });
      }
      if (this.sceneRoot.prepareStoryResources) {
        preparationTasks.push({
          key: "prepare:renderer",
          label: "effects",
          index: 0,
          run: async () => {
            await this.sceneRoot.prepareStoryResources!(story, providerSignal);
          },
        });
      }
      if (preparationTasks.length) {
        const preloadState = this.state.preload as Record<string, unknown> | undefined;
        if (preloadState) {
          preloadState.total = preloadProgressValue(preloadState.total) + preparationTasks.length;
        }
        const prepared = await this.runPreloadTasks(preparationTasks, providerSignal, preparationTasks.length, true);
        if (!prepared) {
          const failures = Array.isArray(preloadState?.failures)
            ? preloadState.failures.join("\n")
            : "Story resource preparation failed";
          throw new Error(`ADV preload failed:\n${failures}`);
        }
      }
      const [pluginResources, rendererResources] = await Promise.all([
        collectStoryResourceDeclarations(this.resourcePreparers, usedCommandResourcePreparers, preparationContext),
        this.sceneRoot.enumerateStoryResources
          ? this.sceneRoot.enumerateStoryResources(story, providerSignal)
          : Promise.resolve([] as const),
      ]);
      declaredResources = Object.freeze([
        ...pluginResources,
        ...normalizeStoryResourceDeclarations(rendererResources, "story scene backend"),
      ]);
      for (const declaration of declaredResources) {
        const label = declaration.label || declaration.kind || "asset";
        switch (declaration.kind) {
          case "texture":
            addTexture(declaration.source, 0);
            break;
          case "video":
            addVideo(declaration.source, 0);
            break;
          case "audio":
            addAudio(
              {
                playableUrl: declaration.source,
                categoryName: declaration.audioCategory ?? "Se",
              },
              declaration.audioCategory ?? "Se",
              0,
            );
            break;
          case "font":
            addFile(label, declaration.source, 0, false);
            break;
          case "file":
          default:
            addFile(label, declaration.source, 0);
            break;
        }
      }
    }
    const defaultRule = story?.runtime?.defaultRuleTransition as AdvRuleTransitionEntry | undefined;
    if (defaultRule?.texture) addTexture(defaultRule.texture, 0);
    if (defaultRule?.maskTexture) addTexture(defaultRule.maskTexture, 0);
    for (let i = 0; i < commands.length; i += 1) {
      for (const cmd of commandsIncludingTimelineEpisodes(commands[i])) {
        addTexture(cmd.background?.url || "", i);
        addTexture(cmd.still?.url || "", i);
        addTexture(cmd.frame?.texture || "", i);
        for (const url of Object.values(cmd.frame?.textures || {})) addTexture(String(url), i);
        for (const edge of cmd.frame?.edges || []) addTexture(edge?.texture || "", i);
        for (const element of cmd.frame?.elements || []) addTexture(element?.texture || "", i);
        for (const url of Object.values(cmd.effect?.textures || {})) addTexture(String(url), i);
        if (cmd.ruleTransition?.texture) addTexture(cmd.ruleTransition.texture, i);
        if (cmd.ruleTransition?.maskTexture) addTexture(cmd.ruleTransition.maskTexture, i);
        addAudio(cmd.bgm, "Bgm", i);
        addAudio(cmd.se, "Se", i);
        addAudio(cmd.chatSound, "Se", i);
        for (const voice of cmd.voices || []) addAudio(voice, "Voice", i);
        addVideo(
          cmd.video?.playableUrl ||
            cmd.video?.src ||
            cmd.video?.url ||
            cmd.movie?.playableUrl ||
            cmd.movie?.src ||
            cmd.movie?.url ||
            cmd.clip?.playableUrl ||
            cmd.clip?.src ||
            cmd.clip?.url ||
            "",
          i,
        );
        if (cmd.characterModel && !supportsRenderReadyCharacters) {
          const usage = animationUsage.get(cmd.characterModel);
          // A declaration that is never selected by an In command is not a
          // runtime dependency. Do not let an absent usage set mean “load the
          // provider's entire animation catalogue”.
          if (usage) {
            await this.collectCharacterProviderResources(
              cmd.characterModel,
              (label, url) => addFile(label, url, i),
              (_label, url) => addTexture(url, i),
              usage,
              providerSignal,
            );
          }
        }
      }
    }
    // Asset catalogues and cover metadata on the story object are lookup data,
    // not runtime dependencies. Scanning them as command zero would preload
    // every exported model, motion, expression, and thumbnail even when no
    // command uses it. Opcode-specific extension fields are still discovered
    // below at their authored command index.
    for (let index = 0; index < commands.length; index += 1) {
      collectDeclaredResourceUrls(
        commands[index],
        (url) => addFile("asset", url, index, !audioRequests.has(url) && !videoUrls.has(url)),
        "",
        false,
        new WeakSet<object>(),
        STORY_RESOURCE_FIELD,
        true,
      );
    }
    if (supportsRenderReadyCharacters) {
      // Scan every descriptor that reaches an authored In and enumerate its
      // complete base payload plus only the motions/expressions selected by the
      // story. Controller creation below then reuses these resident resources.
      const groups = new Map<
        AdvCharacterModelEntry,
        {
          readonly command: AdvCommand;
          readonly animationUsage: CharacterAnimationUsage;
          index: number;
        }
      >();
      for (const warmup of characterWarmups) {
        const model = warmup.command.characterModel;
        if (!model) continue;
        let group = groups.get(model);
        if (!group) {
          group = {
            command: warmup.command,
            index: warmup.index,
            animationUsage: {
              motions: new Set<string>(),
              expressions: new Set<string>(),
            },
          };
          groups.set(model, group);
        }
        group.index = Math.min(group.index, warmup.index);
        for (const name of warmup.animationUsage.motions) {
          group.animationUsage.motions.add(name);
        }
        for (const name of warmup.animationUsage.expressions) {
          group.animationUsage.expressions.add(name);
        }
      }
      await runWithConcurrency([...groups.values()], workerCount, providerSignal, (group) =>
        this.collectCharacterProviderResources(
          group.command.characterModel,
          (label, url) => addFile(label, url, group.index),
          (label, url) => addFile(label, url, group.index),
          group.animationUsage,
          providerSignal,
        ),
      );
    }
    const fontTasks: PreloadTask[] =
      preparationContext && declaredResources.some((declaration) => declaration.kind === "font")
        ? [
            {
              key: "prepare:fonts",
              label: "fonts",
              index: 0,
              run: () => prepareDeclaredStoryFonts(declaredResources, preparationContext!),
            },
          ]
        : [];
    const tasks: PreloadTask[] = [
      ...[...textureUrls].map((url) => ({
        key: `texture:${url}`,
        label: "image",
        index: firstCmdIndex.get(url) ?? 0,
        run: async () => {
          await this.retainEpisodeResource(url, providerSignal);
          if (typeof this.sceneRoot.preloadTexture === "function") {
            await this.sceneRoot.preloadTexture(url, signal);
          } else {
            await this.sceneRoot.loadTexture(url, signal);
          }
        },
      })),
      ...[...fileUrls.entries()]
        .filter(([url]) => !textureUrls.has(url))
        .map(([url, label]) => ({
          key: `file:${url}`,
          label,
          index: firstCmdIndex.get(url) ?? 0,
          run: async () => {
            if (retainedFileUrls.has(url)) {
              await this.retainEpisodeResource(url, providerSignal);
            }
            if (this.sounds) {
              await Promise.all(
                (audioRequests.get(url) || []).map(({ sound, category }) =>
                  this.sounds!.preloadSound(sound, category, providerSignal),
                ),
              );
            }
            if (videoUrls.has(url)) {
              await this.sceneRoot.preloadVideo?.(url, providerSignal);
            }
          },
        })),
    ];
    this.sceneRoot.reservePreloadedTextures?.(textureUrls.size);
    this.backgroundConcurrency = preloadConcurrency(
      supportsRenderReadyCharacters ? story?.runtime?.characterPreloadConcurrency : story?.runtime?.preloadConcurrency,
      supportsRenderReadyCharacters ? 2 : workerCount,
      supportsRenderReadyCharacters ? 4 : 8,
    );
    const characterTasks: PreloadTask[] = characterWarmups.map((warmup) => ({
      key: `character:${warmup.identity}`,
      label: "character",
      index: warmup.index,
      run: async () => {
        const prepared = await this.sceneRoot.preloadCharacter!(
          {
            command: warmup.command,
            commandIndex: warmup.index,
            episodeControllerCount: characterWarmups.length,
            positionType: warmup.positionType,
            motions: Object.freeze([...warmup.animationUsage.motions]),
            expressions: Object.freeze([...warmup.animationUsage.expressions]),
          },
          signal,
        );
        if (prepared === false) {
          throw new Error(`The scene renderer could not preload character ${warmup.target}`);
        }
      },
    }));
    // Keep the full task catalogue only for lifecycle recovery. Every entry is
    // completed before ready, so ordinary playback and seeking do not start a
    // second, command-window preload phase.
    const episodeTasks = [...characterTasks, ...tasks].sort((left, right) => left.index - right.index);
    this.backgroundTasks = episodeTasks;
    this.completedTaskKeys.clear();
    this.scheduledTaskKeys.clear();

    // The loading screen owns the whole episode dependency set: all referenced
    // bytes/textures and every controller's first renderer frame must be ready
    // before the player reports ready. The two bounded pools run concurrently;
    // the shared resolver and texture caches collapse overlapping work.
    const preloadState = this.state.preload as Record<string, unknown> | undefined;
    if (preloadState) {
      const episodeTaskCount = tasks.length + characterTasks.length + fontTasks.length;
      preloadState.total = Math.max(
        preloadProgressValue(preloadState.done),
        preloadProgressValue(preloadState.total) + episodeTaskCount,
      );
      preloadState.done = preloadProgressValue(preloadState.done) + 1;
    }
    await Promise.all([
      this.runPreloadTasks(tasks, signal, workerCount, true),
      this.runPreloadTasks(fontTasks, signal, fontTasks.length || 1, true),
      this.runPreloadTasks(characterTasks, signal, this.backgroundConcurrency, true),
    ]);
    throwIfPreloadAborted(signal);
    if (!signal?.aborted && preloadState && Array.isArray(preloadState.failures) && preloadState.failures.length) {
      throw new Error(`ADV preload failed:\n${preloadState.failures.join("\n")}`);
    }

    this.backgroundWarm = Promise.resolve();
  }

  private async runPreloadTasks(
    tasks: PreloadTask[],
    signal: AbortSignal | undefined,
    baseConcurrency: number,
    tracked: boolean,
  ) {
    throwIfPreloadAborted(signal);
    if (!tasks.length) return true;
    const workerCount = Math.min(tasks.length, baseConcurrency);
    let nextTaskIndex = 0;
    let allCompleted = true;
    const runWorker = async () => {
      while (!signal?.aborted) {
        const task = tasks[nextTaskIndex];
        nextTaskIndex += 1;
        if (!task) return;
        if (tracked) {
          const preloadState = this.state.preload as Record<string, unknown> | undefined;
          if (preloadState) preloadState.label = task.label;
        }
        let completed = true;
        let failure: unknown = null;
        try {
          completed = (await task.run()) !== false;
        } catch (err) {
          completed = false;
          allCompleted = false;
          failure = err;
          if (!signal?.aborted && tracked) {
            const preloadState = this.state.preload as Record<string, unknown> | undefined;
            recordPreloadFailure(preloadState, errorMessage(err));
          }
        }
        if (!completed && failure == null && !signal?.aborted && tracked) {
          const preloadState = this.state.preload as Record<string, unknown> | undefined;
          recordPreloadFailure(preloadState, `Renderer did not make ${task.key} ready`);
        }
        if (completed) this.completedTaskKeys.add(task.key);
        else allCompleted = false;
        this.scheduledTaskKeys.delete(task.key);
        if (tracked) {
          const preloadState = this.state.preload as Record<string, unknown> | undefined;
          if (preloadState)
            (preloadState as Record<string, number>).done = ((preloadState as Record<string, number>).done || 0) + 1;
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, runWorker));
    throwIfPreloadAborted(signal);
    return allCompleted;
  }

  advanceTo(commandIndex: number) {
    this.playbackIndex = Math.max(0, Math.floor(Number(commandIndex) || 0));
    const discarded = this.sceneRoot.advanceCharacterPreload?.(this.playbackIndex, Number.MAX_SAFE_INTEGER);
    for (const identity of discarded ?? []) {
      this.completedTaskKeys.delete(`character:${identity}`);
    }
    if (this.preloadSignal?.aborted) return;
    if (this.backgroundPump) {
      this.backgroundRepumpRequested = true;
      return;
    }
    this.backgroundRepumpRequested = false;
    const pump = this.runBackgroundPump().catch(() => {});
    this.backgroundPump = pump;
    this.backgroundWarm = pump;
    void pump.finally(() => {
      if (this.backgroundPump !== pump) return;
      this.backgroundPump = null;
      if (this.backgroundRepumpRequested && !this.preloadSignal?.aborted) {
        this.backgroundRepumpRequested = false;
        this.advanceTo(this.playbackIndex);
      }
    });
  }

  async waitForBackgroundWarm() {
    let pending = this.backgroundWarm;
    while (pending) {
      await pending;
      if (pending === this.backgroundWarm) return;
      pending = this.backgroundWarm;
    }
  }

  private async runBackgroundPump() {
    while (!this.preloadSignal?.aborted) {
      const tasks = this.backgroundTasks.filter(
        (task) => !this.completedTaskKeys.has(task.key) && !this.scheduledTaskKeys.has(task.key),
      );
      if (!tasks.length) return;
      for (const task of tasks) this.scheduledTaskKeys.add(task.key);
      const allCompleted = await this.runPreloadTasks(tasks, this.preloadSignal, this.backgroundConcurrency, false);
      // A transient renderer lifecycle event may make a controller unavailable.
      // Leave it incomplete and retry when the renderer reports another change.
      if (!allCompleted) return;
    }
  }

  /**
   * Repair renderer-owned resources discarded after the blocking episode
   * preload (for example after WebGL context loss). Under normal playback every
   * task is already complete, so ordinary playback does not schedule it again.
   */
  warmRange(startIndex: number, endIndex: number): Promise<void> {
    const min = Math.max(0, Math.floor(Number(startIndex) || 0));
    const max = Math.max(min, Math.floor(Number(endIndex) || 0));
    const tasks = this.backgroundTasks.filter(
      (task) =>
        task.index >= min &&
        task.index <= max &&
        !this.completedTaskKeys.has(task.key) &&
        !this.scheduledTaskKeys.has(task.key),
    );
    if (!tasks.length) return Promise.resolve();
    for (const task of tasks) this.scheduledTaskKeys.add(task.key);
    return this.runPreloadTasks(tasks, this.preloadSignal, this.backgroundConcurrency, false).then(() => undefined);
  }

  /** Release episode-owned resource leases and cancel lifecycle recovery. */
  dispose(): void {
    this.stopEpisodeLifetime();
  }

  /**
   * Transfers selected-animation ownership to a sequential player instance.
   * The returned leases remain active until adopted or explicitly released.
   */
  takeResourceLeases(): Map<string, StoryResourceLease> {
    const handoff = new Map(this.episodeResourceLeases);
    this.episodeResourceLeases.clear();
    return handoff;
  }

  /** Adopt leases previously detached from a player using the same cache. */
  adoptResourceLeases(leases: Iterable<readonly [string, StoryResourceLease]>): void {
    for (const [url, lease] of leases) {
      if (this.episodeResourceLeases.has(url)) lease.release();
      else this.episodeResourceLeases.set(url, lease);
    }
  }

  private async retainEpisodeResource(url: string, signal: AbortSignal): Promise<void> {
    if (this.episodeResourceLeases.has(url)) return;
    const lease = await this.resources.retain(url, signal);
    try {
      throwIfPreloadAborted(signal);
      if (this.episodeResourceLeases.has(url)) {
        lease.release();
      } else {
        this.episodeResourceLeases.set(url, lease);
      }
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private releaseResourceLeases(): void {
    for (const lease of this.episodeResourceLeases.values()) lease.release();
    this.episodeResourceLeases.clear();
  }

  private stopEpisodeLifetime(releaseLeases = true): void {
    const sourceSignal = this.preloadSourceSignal;
    const sourceAbort = this.preloadSourceAbort;
    this.preloadSourceSignal = undefined;
    this.preloadSourceAbort = undefined;
    if (sourceSignal && sourceAbort) {
      sourceSignal.removeEventListener("abort", sourceAbort);
    }
    const controller = this.preloadController;
    this.preloadController = null;
    controller?.abort();
    this.preloadSignal = undefined;
    if (releaseLeases) this.releaseResourceLeases();
    this.backgroundTasks = [];
    this.backgroundRepumpRequested = false;
    this.backgroundPump = null;
    this.backgroundWarm = null;
    this.completedTaskKeys.clear();
    this.scheduledTaskKeys.clear();
  }

  /** Collect provider-declared character assets before playback starts. */
  private async collectCharacterProviderResources(
    character: AdvCommand["characterModel"],
    addFile: (label: string, url: string, role?: StoryCharacterResourceRole) => void,
    addTexture: (label: string, url: string, role?: StoryCharacterResourceRole) => void,
    animationUsage?: CharacterAnimationUsage,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    if (!character) return;
    const acceptedProviders = this.characterProviders.filter((provider) => provider.supports(character));
    const declarations = await enumerateCharacterProviderResources(acceptedProviders, {
      entry: character,
      ...(animationUsage
        ? {
            animationUsage: Object.freeze({
              motions: Object.freeze([...animationUsage.motions]),
              expressions: Object.freeze([...animationUsage.expressions]),
            }),
          }
        : {}),
      resources: this.resources,
      signal,
    });
    for (const declaration of declarations) {
      if (declaration.kind === "texture") {
        addTexture(declaration.label || "character texture", declaration.source, declaration.role);
      } else {
        addFile(declaration.label || "character", declaration.source, declaration.role);
      }
    }
    if (acceptedProviders.length) return;
    const portrait = staticPortraitSource(character);
    if (portrait) addTexture("character portrait", portrait);
  }

  fetchUrl(url: string) {
    if (this.preloadSignal?.aborted) {
      return Promise.reject(resourceRequestError("AbortError", `Loading was aborted: ${url}`));
    }
    const fetched = fetchedUrlsFor(this.resources);
    let shared = fetched.get(url);
    if (!shared) {
      const controller = new AbortController();
      shared = {
        controller,
        pending: Promise.resolve(),
        settled: false,
        waiters: 0,
      };
      const request = shared;
      shared.pending = Promise.resolve()
        // Preload only establishes the canonical resident bytes. It never
        // mutates or returns them, so avoid allocating a disposable copy of
        // every episode asset when the resolver exposes its trusted fast path.
        .then(() =>
          this.resources.loadSharedBytes
            ? this.resources.loadSharedBytes(url, controller.signal)
            : this.resources.load(url, controller.signal),
        )
        .then(() => undefined)
        .catch((err) => {
          if (fetched.get(url) === request) fetched.delete(url);
          throw err;
        })
        .finally(() => {
          request.settled = true;
          if (fetched.get(url) === request) fetched.delete(url);
        });
      rememberSharedFetch(fetched, url, shared);
    } else {
      rememberSharedFetch(fetched, url, shared);
    }
    return waitForSharedFetch(shared, fetched, this.preloadSignal, url);
  }

  registerCharacterAsset(cmd: AdvCommand) {
    if (!hasAdvCharacterModel(cmd?.characterModel)) return;
    const index = Number(cmd.targetAssetIndex) || 0;
    for (const target of commandTargetNames(cmd, "・")) {
      this.characterVariants.set(`${target}\u0000${index}`, {
        characterModel: cmd.characterModel!,
        characterKey: cmd.characterKey,
        targetAssetIndex: index,
      });
    }
  }

  resolveCharacterForTarget(target: string, index = 0) {
    return this.characterVariants.get(`${target}\u0000${Number(index) || 0}`) || null;
  }

  setCharacterAssetIndex(target: string, index = 0) {
    if (!target) return;
    this.characterAssetIndices.set(target, Number(index) || 0);
  }

  resolveCurrentCharacterForTarget(target: string) {
    if (!this.characterAssetIndices.has(target)) return null;
    const index = this.characterAssetIndices.get(target);
    return this.resolveCharacterForTarget(target, index == null ? 0 : index);
  }

  resolveCharacterForIn(target: string, index = 0) {
    if (this.characterAssetIndices.has(target)) {
      return this.resolveCurrentCharacterForTarget(target);
    }
    return this.resolveCharacterForTarget(target, index);
  }

  createSnapshot(): AdvEpisodeResourceSnapshot {
    return {
      // Variant manifests are immutable story data; preserve their references
      // when a host serializes loader state.
      characterVariants: [...this.characterVariants.entries()],
      characterAssetIndices: [...this.characterAssetIndices.entries()],
      playbackIndex: this.playbackIndex,
    };
  }

  restoreSnapshot(snapshot: AdvEpisodeResourceSnapshot | null) {
    if (!snapshot) return;
    this.characterVariants = new Map((snapshot.characterVariants as Array<[string, AdvCharacterVariant]>) || []);
    this.characterAssetIndices = new Map((snapshot.characterAssetIndices as Array<[string, number]>) || []);
    this.playbackIndex = Math.max(0, Math.trunc(Number(snapshot.playbackIndex) || 0));
  }
}

function isLocalRuntimeUrl(value: string): boolean {
  return isCanonicalStoryResourceUrl(value);
}

function assertLocalRuntimeUrl(label: string, value: string) {
  const url = value || "";
  if (url) requireCanonicalStoryResourceUrl(url, `${label} resource`);
}

const STORY_RESOURCE_FIELD = /(?:url$|^(?:src|source|runtime|model)$|textures?$)/i;
const STORY_RESOURCE_COLLECTION = /textures$/i;
const PROVIDER_OWNED_STORY_FIELD = /^characterModel$/iu;
function assertNestedCanonicalResourceUrls(
  value: unknown,
  label = "story",
  field = "",
  directResource = false,
  seen = new WeakSet<object>(),
  resourceField = STORY_RESOURCE_FIELD,
) {
  if (typeof value === "string") {
    if (!value || (!directResource && !resourceField.test(field))) return;
    if (field.toLocaleLowerCase() === "source" && !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return;
    requireCanonicalStoryResourceUrl(value, label);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const valuesAreResources = STORY_RESOURCE_COLLECTION.test(field);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNestedCanonicalResourceUrls(entry, `${label}[${index}]`, "", valuesAreResources, seen, resourceField);
    });
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PROVIDER_OWNED_STORY_FIELD.test(key)) continue;
    assertNestedCanonicalResourceUrls(entry, `${label}.${key}`, key, valuesAreResources, seen, resourceField);
  }
}

function collectDeclaredResourceUrls(
  value: unknown,
  add: (url: string) => void,
  field = "",
  directResource = false,
  seen = new WeakSet<object>(),
  resourceField = STORY_RESOURCE_FIELD,
  skipAnimationCatalogs = false,
) {
  if (typeof value === "string") {
    if (!value || (!directResource && !resourceField.test(field))) return;
    if (field.toLocaleLowerCase() === "source" && !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)) return;
    if (isCanonicalStoryResourceUrl(value)) add(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const valuesAreResources = STORY_RESOURCE_COLLECTION.test(field);
  if (Array.isArray(value)) {
    value.forEach((entry) =>
      collectDeclaredResourceUrls(entry, add, "", valuesAreResources, seen, resourceField, skipAnimationCatalogs),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PROVIDER_OWNED_STORY_FIELD.test(key)) continue;
    if (skipAnimationCatalogs && ANIMATION_CATALOG_FIELD.test(key)) continue;
    collectDeclaredResourceUrls(entry, add, key, valuesAreResources, seen, resourceField, skipAnimationCatalogs);
  }
}

const ANIMATION_CATALOG_FIELD = /^(?:motions|expressions)$/iu;

function collectReferencedCharacterAnimations(
  commands: AdvCommand[],
  targetNameSplitKey: unknown,
): Map<AdvCharacterModelEntry, CharacterAnimationUsage> {
  const usage = new Map<AdvCharacterModelEntry, CharacterAnimationUsage>();
  const variants = new Map<string, Map<number, AdvCharacterModelEntry>>();
  const selectedIndices = new Map<string, number>();
  const activeModels = new Map<string, AdvCharacterModelEntry>();
  const separator = typeof targetNameSplitKey === "string" ? targetNameSplitKey : "・";
  const ensureUsage = (model: AdvCharacterModelEntry): CharacterAnimationUsage => {
    let entry = usage.get(model);
    if (!entry) {
      entry = { motions: new Set(), expressions: new Set() };
      usage.set(model, entry);
    }
    return entry;
  };
  const recordInAnimations = (command: AdvCommand, model: AdvCharacterModelEntry) => {
    const entry = ensureUsage(model);
    const motionName = firstStringValue(command.characterPresentation?.motionName, command.motionName);
    const expressionName = firstStringValue(command.characterPresentation?.expressionName, command.expressionName);
    if (motionName) entry.motions.add(motionName);
    if (expressionName) entry.expressions.add(expressionName);
    const defaults = characterDefaultPresentation(model);
    if ((!motionName || defaults.playDefaultMotionBeforePresentation) && defaults.motionName) {
      entry.motions.add(defaults.motionName);
    }
    if (!expressionName && defaults.expressionName) {
      entry.expressions.add(defaults.expressionName);
    }
  };
  const recordAnimationCommand = (command: AdvCommand, model: AdvCharacterModelEntry) => {
    const entry = ensureUsage(model);
    recordAnimationCommandUsage(entry, command);
  };

  for (const root of commands) {
    for (const command of commandsIncludingTimelineEpisodes(root)) {
      const opcode = Number(command.command);
      const targets = commandTargetNames(command, separator);
      const model = hasAdvCharacterModel(command.characterModel) ? command.characterModel : undefined;
      const assetIndex = finiteAssetIndex(command.targetAssetIndex);

      if (opcode === ADV_COMMAND.Character && model) {
        for (const target of targets) {
          let targetVariants = variants.get(target);
          if (!targetVariants) {
            targetVariants = new Map();
            variants.set(target, targetVariants);
          }
          targetVariants.set(assetIndex, model);
        }
        continue;
      }

      if (opcode === ADV_COMMAND.Costume) {
        for (const target of targets) {
          selectedIndices.set(target, assetIndex);
          const selected = variants.get(target)?.get(assetIndex);
          if (selected) {
            activeModels.set(target, selected);
            ensureUsage(selected);
          } else {
            activeModels.delete(target);
          }
        }
        continue;
      }

      if (opcode === ADV_COMMAND.In) {
        for (const target of targets) {
          const selectedIndex = model
            ? assetIndex
            : selectedIndices.has(target)
              ? selectedIndices.get(target)!
              : assetIndex;
          const selected = model || variants.get(target)?.get(selectedIndex);
          if (!selected) continue;
          if (model) {
            let targetVariants = variants.get(target);
            if (!targetVariants) {
              targetVariants = new Map();
              variants.set(target, targetVariants);
            }
            targetVariants.set(selectedIndex, model);
          }
          activeModels.set(target, selected);
          selectedIndices.set(target, selectedIndex);
          recordInAnimations(command, selected);
        }
        continue;
      }

      if (!commandHasCharacterAnimation(command)) {
        continue;
      }
      for (const target of targets) {
        const active = activeModels.get(target);
        if (active) recordAnimationCommand(command, active);
      }
    }
  }
  return usage;
}

/**
 * Resolve the first authored In for every TargetName+AssetIndex controller.
 *
 * This mirrors the Character/Costume/In selection state used by playback. The
 * resulting animation sets contain only names observed in commands for the
 * resolved model; provider catalogue entries that never appear in the story
 * are intentionally absent.
 */
function collectCharacterWarmupRequests(commands: AdvCommand[], targetNameSplitKey: unknown): CharacterWarmupRequest[] {
  const separator = typeof targetNameSplitKey === "string" ? targetNameSplitKey : "・";
  const variants = new Map<string, Map<number, AdvCharacterVariant>>();
  const asynchronousVariants = new Map<string, Map<number, AdvCharacterVariant>>();
  const selectedIndices = new Map<string, number>();
  const activeIdentities = new Map<string, string>();
  const warmups = new Map<string, CharacterWarmupRequest>();
  const asynchronousAnimationCommands: Array<{
    readonly command: AdvCommand;
    readonly targets: readonly string[];
  }> = [];

  for (let index = 0; index < commands.length; index += 1) {
    for (const traversed of commandsIncludingTimelineEpisodesWithContext(commands[index])) {
      const command = traversed.command;
      const opcode = Number(command.command);
      const targets = commandTargetNames(command, separator);
      const assetIndex = finiteAssetIndex(command.targetAssetIndex);
      const inlineModel = hasAdvCharacterModel(command.characterModel) ? command.characterModel : undefined;

      if (opcode === ADV_COMMAND.Character && inlineModel) {
        for (const target of targets) {
          const registry = traversed.asynchronous ? asynchronousVariants : variants;
          let byIndex = registry.get(target);
          if (!byIndex) {
            byIndex = new Map();
            registry.set(target, byIndex);
          }
          byIndex.set(assetIndex, {
            characterModel: inlineModel,
            characterKey: command.characterKey,
            targetAssetIndex: assetIndex,
          });
        }
        continue;
      }

      if (opcode === ADV_COMMAND.Costume) {
        if (!traversed.asynchronous) {
          for (const target of targets) {
            selectedIndices.set(target, assetIndex);
            const identity = `${target}\u0000${assetIndex}`;
            if (warmups.has(identity)) activeIdentities.set(target, identity);
          }
        }
        continue;
      }

      if (opcode === ADV_COMMAND.In) {
        for (const target of targets) {
          const selectedIndex = inlineModel ? assetIndex : (selectedIndices.get(target) ?? assetIndex);
          const variant = inlineModel
            ? {
                characterModel: inlineModel,
                characterKey: command.characterKey,
                targetAssetIndex: selectedIndex,
              }
            : traversed.asynchronous
              ? (asynchronousVariants.get(target)?.get(selectedIndex) ?? variants.get(target)?.get(selectedIndex))
              : variants.get(target)?.get(selectedIndex);
          if (!variant) continue;
          if (inlineModel && !traversed.asynchronous) {
            let byIndex = variants.get(target);
            if (!byIndex) {
              byIndex = new Map();
              variants.set(target, byIndex);
            }
            byIndex.set(selectedIndex, variant);
          }
          const identity = `${target}\u0000${selectedIndex}`;
          let warmup = warmups.get(identity);
          if (!warmup) {
            warmup = {
              identity,
              target,
              index,
              command: {
                ...command,
                targetName: target,
                targets: [{ target }],
                characterModel: variant.characterModel,
                characterKey: variant.characterKey,
                targetAssetIndex: selectedIndex,
                controllerIdentity: identity,
              },
              positionType: Number(command.positionType) || 5,
              animationUsage: {
                motions: new Set<string>(),
                expressions: new Set<string>(),
              },
            };
            warmups.set(identity, warmup);
          }
          recordInAnimationUsage(warmup.animationUsage, command, variant.characterModel);
          if (!traversed.asynchronous) {
            activeIdentities.set(target, identity);
          }
          // A no-wait In selects the scene controller immediately, but the
          // loader's asset index changes only when its detached placement
          // finishes. Do not let a static scan prematurely commit that index.
          if (!command.noWait && !traversed.asynchronous) {
            selectedIndices.set(target, selectedIndex);
          }
        }
        continue;
      }

      if (!commandHasCharacterAnimation(command)) {
        continue;
      }
      if (traversed.asynchronous) {
        asynchronousAnimationCommands.push({ command, targets });
        continue;
      }
      for (const target of targets) {
        const identity = activeIdentities.get(target);
        const warmup = identity ? warmups.get(identity) : undefined;
        if (warmup) {
          recordAnimationCommandUsage(warmup.animationUsage, command);
        }
      }
    }
  }

  // Delayed group/timeline actions execute against whichever controller is
  // selected when their signal fires, not the controller active at the parent
  // command. Bind only the referenced names, but conservatively to every
  // reachable controller for that target so an interleaving cannot underfetch.
  for (const { command, targets } of asynchronousAnimationCommands) {
    for (const target of targets) {
      for (const warmup of warmups.values()) {
        if (warmup.target === target) {
          recordAnimationCommandUsage(warmup.animationUsage, command);
        }
      }
    }
  }

  return [...warmups.values()].sort((left, right) => left.index - right.index);
}

function commandTargetNames(command: AdvCommand, separator: string): string[] {
  const explicit = (command.targets || []).map((entry) => stringValue(entry?.target)).filter(Boolean);
  return explicit.length ? [...new Set(explicit)] : splitAdvTargetNames(command.targetName, separator);
}

function finiteAssetIndex(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstStringValue(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function characterDefaultPresentation(model: AdvCharacterModelEntry): {
  readonly motionName: string;
  readonly expressionName: string;
  readonly playDefaultMotionBeforePresentation: boolean;
} {
  const source = objectValue(model);
  const runtime = objectValue(source.runtime);
  const profile = objectValue(source.profile);
  return {
    motionName: firstStringValue(profile.defaultMotionName, runtime.defaultMotionName, source.defaultMotionName),
    expressionName: firstStringValue(
      profile.defaultExpressionName,
      runtime.defaultExpressionName,
      source.defaultExpressionName,
    ),
    playDefaultMotionBeforePresentation: profile.playDefaultMotionBeforePresentation === true,
  };
}

function recordInAnimationUsage(
  usage: CharacterAnimationUsage,
  command: AdvCommand,
  model: AdvCharacterModelEntry,
): void {
  const motionName = firstStringValue(command.characterPresentation?.motionName, command.motionName);
  const expressionName = firstStringValue(command.characterPresentation?.expressionName, command.expressionName);
  if (motionName) usage.motions.add(motionName);
  if (expressionName) usage.expressions.add(expressionName);
  const defaults = characterDefaultPresentation(model);
  if ((!motionName || defaults.playDefaultMotionBeforePresentation) && defaults.motionName) {
    usage.motions.add(defaults.motionName);
  }
  if (!expressionName && defaults.expressionName) {
    usage.expressions.add(defaults.expressionName);
  }
}

function recordAnimationCommandUsage(usage: CharacterAnimationUsage, command: AdvCommand): void {
  const opcode = Number(command.command);
  if (opcode === ADV_COMMAND.Motion) {
    const motionName = firstStringValue(command.motionName);
    const expressionName = firstStringValue(command.expressionName);
    if (motionName) usage.motions.add(motionName);
    if (expressionName) usage.expressions.add(expressionName);
  } else if (opcode === ADV_COMMAND.Expression) {
    const expressionName = firstStringValue(command.expressionName);
    if (expressionName) usage.expressions.add(expressionName);
  }
  if (commandInvokesCharacterPresentation(command)) {
    const motionName = firstStringValue(command.characterPresentation?.motionName);
    const expressionName = firstStringValue(command.characterPresentation?.expressionName);
    if (motionName) usage.motions.add(motionName);
    if (expressionName) usage.expressions.add(expressionName);
  }
}

function commandInvokesCharacterPresentation(command: AdvCommand): boolean {
  const opcode = Number(command.command);
  if (opcode === ADV_COMMAND.In || opcode === ADV_COMMAND.Out) return true;
  const movementOpcodes = new Set<number>([
    ADV_COMMAND.MoveToRight,
    ADV_COMMAND.MoveToLeft,
    ADV_COMMAND.MoveToUp,
    ADV_COMMAND.MoveToDown,
    ADV_COMMAND.MoveToForward,
    ADV_COMMAND.MoveToBack,
    ADV_COMMAND.MoveToDirection,
  ]);
  return movementOpcodes.has(opcode) && Boolean(command.characterWorldTransition || command.characterWorldPosition);
}

function commandHasCharacterAnimation(command: AdvCommand): boolean {
  const opcode = Number(command.command);
  return (
    opcode === ADV_COMMAND.Motion || opcode === ADV_COMMAND.Expression || commandInvokesCharacterPresentation(command)
  );
}

function staticPortraitSource(character: AdvCharacterModelEntry): string {
  const source = character as Record<string, unknown>;
  const runtime =
    source.runtime && typeof source.runtime === "object" && !Array.isArray(source.runtime)
      ? (source.runtime as Record<string, unknown>)
      : {};
  const explicitImage = firstStringValue(runtime.imageUrl, source.imageUrl);
  if (explicitImage) return explicitImage;
  if (firstStringValue(runtime.format, source.format).toLowerCase() !== "static-portrait") {
    return "";
  }
  return firstStringValue(
    runtime.model,
    runtime.modelUrl,
    runtime.url,
    runtime.src,
    runtime.source,
    source.model,
    source.modelUrl,
    source.url,
    source.src,
    source.source,
  );
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function recordPreloadFailure(preloadState: Record<string, unknown> | undefined, message: string): void {
  if (!Array.isArray(preloadState?.failures)) return;
  if (!preloadState.failures.includes(message)) {
    preloadState.failures.push(message);
  }
}

function preloadConcurrency(value: unknown, fallback = 8, max = 16) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function preloadProgressValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

/**
 * Native `PreloadFromTimeline` traverses the AdvEpisodeSignal rows
 * and preloads their command resources at the parent Timeline command's
 * position. Recursive Timeline episodes are rejected by the native helper.
 */
function commandsIncludingTimelineEpisodes(command: AdvCommand): AdvCommand[] {
  return commandsIncludingTimelineEpisodesWithContext(command).map(({ command: entry }) => entry);
}

function commandsIncludingTimelineEpisodesWithContext(
  command: AdvCommand,
): Array<{ readonly command: AdvCommand; readonly asynchronous: boolean }> {
  const commands: Array<{
    readonly command: AdvCommand;
    readonly asynchronous: boolean;
  }> = [];
  const seen = new Set<AdvCommand>();
  const visit = (entry: AdvCommand, asynchronous: boolean): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    commands.push({ command: entry, asynchronous });
    for (const nested of advCommandGroupCommands(entry)) visit(nested, true);
    for (const signal of sortAdvTimelineSignals(entry.timeline?.signals || [])) {
      if (Number(signal.episode?.command) !== 45) visit(signal.episode, true);
    }
  };
  visit(command, false);
  return commands;
}
