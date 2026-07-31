import { hasAdvCharacterModel } from "../types/AdvRuntime";
import type {
  AdvCharacterModelEntry,
  AdvCharacterVariant,
  AdvCommand,
  AdvRuleTransitionEntry,
  AdvStory,
} from "../types/AdvRuntime";
import type {
  StoryResourceBackend,
  StoryResourceResolver,
} from "../rendering/StorySceneBackend";
import {
  enumerateCharacterProviderResources,
  type StoryCharacterProvider,
} from "../rendering/StoryCharacterModel";
import { DefaultStoryResourceResolver } from "../resources/StoryResourceResolver";
import {
  isCanonicalStoryResourceUrl,
  requireCanonicalStoryResourceUrl,
} from "../runtime";
import { advCommandGroupCommands } from "./AdvCommandGroup";
import { splitAdvTargetNames } from "./AdvCommandText";
import { ADV_COMMAND } from "./AdvConstants";
import { sortAdvTimelineSignals } from "./AdvPlayableDirector";

interface SharedFetch {
  readonly controller: AbortController;
  pending: Promise<void>;
  settled: boolean;
  waiters: number;
}

const sharedFetchedUrls = new WeakMap<
  StoryResourceResolver,
  Map<string, SharedFetch>
>();
const MAX_SHARED_FETCH_KEYS = 512;

function resourceRequestError(name: "AbortError", message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
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
    return Promise.reject(
      resourceRequestError("AbortError", `Loading was aborted: ${url}`),
    );
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
    const abort = (): void =>
      finish(() =>
        reject(
          resourceRequestError("AbortError", `Loading was aborted: ${url}`),
        ),
      );
    signal?.addEventListener("abort", abort, { once: true });
    shared.pending.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

const fetchedUrlsFor = (
  resources: StoryResourceResolver,
): Map<string, SharedFetch> => {
  let fetched = sharedFetchedUrls.get(resources);
  if (!fetched) {
    fetched = new Map();
    sharedFetchedUrls.set(resources, fetched);
  }
  return fetched;
};

const rememberSharedFetch = (
  fetched: Map<string, SharedFetch>,
  url: string,
  request: SharedFetch,
) => {
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
  run: () => Promise<void>;
};

interface CharacterAnimationUsage {
  readonly motions: Set<string>;
  readonly expressions: Set<string>;
}

export interface AdvEpisodeResourceSnapshot {
  readonly characterVariants: Array<[string, AdvCharacterVariant]>;
  readonly characterAssetIndices: Array<[string, number]>;
  readonly playbackIndex: number;
}

export class AdvEpisodeResourceLoader {
  sceneRoot: StoryResourceBackend;
  state: Record<string, unknown>;
  characterVariants: Map<string, AdvCharacterVariant>;
  characterAssetIndices: Map<string, number>;
  backgroundWarm: Promise<void> | null;
  private backgroundTasks: PreloadTask[];
  private backgroundPump: Promise<void> | null;
  private completedTaskKeys: Set<string>;
  private scheduledTaskKeys: Set<string>;
  private preloadSignal?: AbortSignal;
  private preloadAheadCommands: number;
  private preloadBehindCommands: number;
  private backgroundConcurrency: number;
  private playbackIndex: number;
  private readonly resources: StoryResourceResolver;
  private readonly characterProviders: readonly StoryCharacterProvider[];
  constructor(
    sceneRoot: StoryResourceBackend,
    state: Record<string, unknown>,
    resources: StoryResourceResolver = new DefaultStoryResourceResolver(),
    characterProviders: readonly StoryCharacterProvider[] = [],
  ) {
    this.sceneRoot = sceneRoot;
    this.state = state;
    this.resources = resources;
    this.characterProviders = Object.freeze([...characterProviders]);
    this.characterVariants = new Map<string, AdvCharacterVariant>();
    this.characterAssetIndices = new Map<string, number>();
    this.backgroundWarm = null;
    this.backgroundTasks = [];
    this.backgroundPump = null;
    this.completedTaskKeys = new Set();
    this.scheduledTaskKeys = new Set();
    this.preloadAheadCommands = 192;
    this.preloadBehindCommands = 24;
    this.backgroundConcurrency = 6;
    this.playbackIndex = 0;
  }

  async preload(story: AdvStory | null | undefined, signal?: AbortSignal) {
    this.preloadSignal = signal;
    const providerSignal = signal ?? new AbortController().signal;
    assertNestedCanonicalResourceUrls(story);
    const commands = story?.commands || [];
    const animationUsage = collectReferencedCharacterAnimations(
      commands,
      story?.runtime?.targetNameSplitKey,
    );
    const textureUrls = new Set<string>();
    const fileUrls = new Map<string, string>();
    const firstCmdIndex = new Map<string, number>();
    const noteIndex = (url: string, index: number) => {
      if (!firstCmdIndex.has(url)) firstCmdIndex.set(url, index);
    };
    const addFile = (label: string, url: string, index: number) => {
      assertLocalRuntimeUrl(label, url);
      if (!isLocalRuntimeUrl(url)) return;
      fileUrls.set(url, label);
      noteIndex(url, index);
    };
    const addTexture = (url: string, index: number) => {
      assertLocalRuntimeUrl("image", url);
      if (!isLocalRuntimeUrl(url)) return;
      textureUrls.add(url);
      fileUrls.set(url, "image");
      noteIndex(url, index);
    };
    const defaultRule = story?.runtime?.defaultRuleTransition as
      AdvRuleTransitionEntry | undefined;
    if (defaultRule?.texture) addTexture(defaultRule.texture, 0);
    else if (defaultRule?.maskTexture) addTexture(defaultRule.maskTexture, 0);
    for (let i = 0; i < commands.length; i += 1) {
      for (const cmd of commandsIncludingTimelineEpisodes(commands[i])) {
        addTexture(cmd.background?.url || "", i);
        addTexture(cmd.still?.url || "", i);
        addTexture(cmd.frame?.texture || "", i);
        for (const url of Object.values(cmd.frame?.textures || {}))
          addTexture(String(url), i);
        for (const edge of cmd.frame?.edges || [])
          addTexture(edge?.texture || "", i);
        for (const element of cmd.frame?.elements || [])
          addTexture(element?.texture || "", i);
        for (const url of Object.values(cmd.effect?.textures || {}))
          addTexture(String(url), i);
        if (cmd.ruleTransition?.texture)
          addTexture(cmd.ruleTransition.texture, i);
        if (cmd.ruleTransition?.maskTexture)
          addTexture(cmd.ruleTransition.maskTexture, i);
        addFile("bgm", cmd.bgm?.playableUrl || "", i);
        addFile("se", cmd.se?.playableUrl || "", i);
        for (const voice of cmd.voices || [])
          addFile("voice", voice?.playableUrl || "", i);
        addFile(
          "video",
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
        if (cmd.characterModel) {
          const usage = animationUsage.get(cmd.characterModel);
          await this.collectCharacterProviderResources(
            cmd.characterModel,
            (label, url) => addFile(label, url, i),
            (url) => addTexture(url, i),
            usage,
            providerSignal,
          );
        }
      }
    }
    // Some story exports keep assets in metadata or opcode-specific extension
    // fields. Include every declared canonical resource URL, not only the
    // fields understood by the current renderer.
    collectDeclaredResourceUrls(
      story,
      (url) => addFile("asset", url, 0),
      "",
      false,
      new WeakSet<object>(),
      STORY_RESOURCE_FIELD,
      true,
    );
    const tasks: PreloadTask[] = [
      ...[...textureUrls].map((url) => ({
        key: `texture:${url}`,
        label: "image",
        index: firstCmdIndex.get(url) ?? 0,
        run: async () => {
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
          run: () => this.fetchUrl(url),
        })),
    ];
    const workerCount = preloadConcurrency(story?.runtime?.preloadConcurrency);
    this.preloadAheadCommands = preloadWindow(
      story?.runtime?.preloadAheadCommands,
      192,
      8,
      384,
    );
    this.preloadBehindCommands = preloadWindow(
      story?.runtime?.preloadBehindCommands,
      24,
      0,
      64,
    );
    this.backgroundConcurrency = preloadConcurrency(
      story?.runtime?.preloadBackgroundConcurrency,
      6,
      8,
    );
    // Entering a story is gated on every URL declared directly by the story.
    // Provider manifests may discover their own nested dependencies while
    // constructing a model; those remain the provider's resource-boundary job.
    this.backgroundTasks = [];
    this.completedTaskKeys.clear();
    this.scheduledTaskKeys.clear();

    // Every directly declared task is blocking. A failure prevents entry.
    const preloadState = this.state.preload as
      Record<string, unknown> | undefined;
    if (preloadState) {
      preloadState.total = tasks.length;
      preloadState.done = 0;
      preloadState.failures = [];
    }
    await this.runPreloadTasks(tasks, signal, workerCount, true);
    if (
      !signal?.aborted &&
      preloadState &&
      Array.isArray(preloadState.failures) &&
      preloadState.failures.length
    ) {
      throw new Error(
        `ADV preload failed:\n${preloadState.failures.join("\n")}`,
      );
    }

    if (!this.backgroundWarm) this.backgroundWarm = Promise.resolve();
  }

  private async runPreloadTasks(
    tasks: PreloadTask[],
    signal: AbortSignal | undefined,
    baseConcurrency: number,
    tracked: boolean,
  ) {
    if (!tasks.length) return;
    const workerCount = Math.min(tasks.length, baseConcurrency);
    let nextTaskIndex = 0;
    const runWorker = async () => {
      while (!signal?.aborted) {
        const task = tasks[nextTaskIndex];
        nextTaskIndex += 1;
        if (!task) return;
        if (tracked) {
          const preloadState = this.state.preload as
            Record<string, unknown> | undefined;
          if (preloadState) preloadState.label = task.label;
        }
        try {
          await task.run();
        } catch (err) {
          if (!signal?.aborted && tracked) {
            const preloadState = this.state.preload as
              Record<string, unknown> | undefined;
            if (preloadState && Array.isArray(preloadState.failures)) {
              preloadState.failures.push(errorMessage(err));
            }
          }
        }
        this.completedTaskKeys.add(task.key);
        this.scheduledTaskKeys.delete(task.key);
        if (tracked) {
          const preloadState = this.state.preload as
            Record<string, unknown> | undefined;
          if (preloadState)
            (preloadState as Record<string, number>).done =
              ((preloadState as Record<string, number>).done || 0) + 1;
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, runWorker));
  }

  advanceTo(commandIndex: number) {
    this.playbackIndex = Math.max(0, Math.floor(Number(commandIndex) || 0));
    if (this.backgroundPump || this.preloadSignal?.aborted) return;
    const pump = this.runBackgroundPump().catch(() => {});
    this.backgroundPump = pump;
    this.backgroundWarm = pump;
    void pump.finally(() => {
      if (this.backgroundPump !== pump) return;
      this.backgroundPump = null;
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
      const minIndex = Math.max(
        0,
        this.playbackIndex - this.preloadBehindCommands,
      );
      const maxIndex = this.playbackIndex + this.preloadAheadCommands;
      const tasks = this.backgroundTasks.filter(
        (task) =>
          task.index >= minIndex &&
          task.index <= maxIndex &&
          !this.completedTaskKeys.has(task.key) &&
          !this.scheduledTaskKeys.has(task.key),
      );
      if (!tasks.length) return;
      for (const task of tasks) this.scheduledTaskKeys.add(task.key);
      await this.runPreloadTasks(
        tasks,
        this.preloadSignal,
        this.backgroundConcurrency,
        false,
      );
    }
  }

  /**
   * Warm every Phase-2 resource whose command index falls in [startIndex, endIndex]
   * at background concurrency, independently of the rolling playback pump. Used by
   * seek so resources load in parallel while the deterministic replay loop re-applies
   * command state serially. Safe to fire without awaiting: it shares the pump's
   * completed/scheduled key sets, so nothing double-loads and the pump picks up any
   * tasks this pass did not finish.
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
    return this.runPreloadTasks(
      tasks,
      this.preloadSignal,
      this.backgroundConcurrency,
      false,
    );
  }

  /** Collect provider-declared character assets before playback starts. */
  private async collectCharacterProviderResources(
    character: AdvCommand["characterModel"],
    addFile: (label: string, url: string) => void,
    addTexture: (url: string) => void,
    animationUsage?: CharacterAnimationUsage,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    if (!character) return;
    const acceptedProviders = this.characterProviders.filter((provider) =>
      provider.supports(character),
    );
    const declarations = await enumerateCharacterProviderResources(
      acceptedProviders,
      {
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
      },
    );
    for (const declaration of declarations) {
      if (declaration.kind === "texture") {
        addTexture(declaration.source);
      } else {
        addFile(declaration.label || "character", declaration.source);
      }
    }
    if (acceptedProviders.length) return;
    const portrait = staticPortraitSource(character);
    if (portrait) addTexture(portrait);
  }

  fetchUrl(url: string) {
    if (this.preloadSignal?.aborted) {
      return Promise.reject(
        resourceRequestError("AbortError", `Loading was aborted: ${url}`),
      );
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
        .then(() => this.resources.load(url, controller.signal))
        .then(() => undefined)
        .catch((err) => {
          if (fetched.get(url) === request) fetched.delete(url);
          throw err;
        })
        .finally(() => {
          request.settled = true;
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
    return (
      this.characterVariants.get(`${target}\u0000${Number(index) || 0}`) || null
    );
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
    this.characterVariants = new Map(
      (snapshot.characterVariants as Array<[string, AdvCharacterVariant]>) ||
        [],
    );
    this.characterAssetIndices = new Map(
      (snapshot.characterAssetIndices as Array<[string, number]>) || [],
    );
    this.playbackIndex = Math.max(
      0,
      Math.trunc(Number(snapshot.playbackIndex) || 0),
    );
  }
}

function isLocalRuntimeUrl(value: string): boolean {
  return isCanonicalStoryResourceUrl(value);
}

function assertLocalRuntimeUrl(label: string, value: string) {
  const url = value || "";
  if (url) requireCanonicalStoryResourceUrl(url, `${label} resource`);
}

const STORY_RESOURCE_FIELD =
  /(?:url$|^(?:src|source|runtime|model)$|textures?$)/i;
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
    if (
      field.toLocaleLowerCase() === "source" &&
      !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)
    )
      return;
    requireCanonicalStoryResourceUrl(value, label);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const valuesAreResources = STORY_RESOURCE_COLLECTION.test(field);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertNestedCanonicalResourceUrls(
        entry,
        `${label}[${index}]`,
        "",
        valuesAreResources,
        seen,
        resourceField,
      );
    });
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PROVIDER_OWNED_STORY_FIELD.test(key)) continue;
    assertNestedCanonicalResourceUrls(
      entry,
      `${label}.${key}`,
      key,
      valuesAreResources,
      seen,
      resourceField,
    );
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
    if (
      field.toLocaleLowerCase() === "source" &&
      !/^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(value)
    )
      return;
    if (isCanonicalStoryResourceUrl(value)) add(value);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const valuesAreResources = STORY_RESOURCE_COLLECTION.test(field);
  if (Array.isArray(value)) {
    value.forEach((entry) =>
      collectDeclaredResourceUrls(
        entry,
        add,
        "",
        valuesAreResources,
        seen,
        resourceField,
        skipAnimationCatalogs,
      ),
    );
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PROVIDER_OWNED_STORY_FIELD.test(key)) continue;
    if (skipAnimationCatalogs && ANIMATION_CATALOG_FIELD.test(key)) continue;
    collectDeclaredResourceUrls(
      entry,
      add,
      key,
      valuesAreResources,
      seen,
      resourceField,
      skipAnimationCatalogs,
    );
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
  const separator =
    typeof targetNameSplitKey === "string" ? targetNameSplitKey : "・";
  const ensureUsage = (
    model: AdvCharacterModelEntry,
  ): CharacterAnimationUsage => {
    let entry = usage.get(model);
    if (!entry) {
      entry = { motions: new Set(), expressions: new Set() };
      usage.set(model, entry);
    }
    return entry;
  };
  const recordCommandAnimations = (
    command: AdvCommand,
    model: AdvCharacterModelEntry,
  ) => {
    const entry = ensureUsage(model);
    const motionName = firstStringValue(
      command.characterPresentation?.motionName,
      command.motionName,
    );
    const expressionName = firstStringValue(
      command.characterPresentation?.expressionName,
      command.expressionName,
    );
    if (motionName) entry.motions.add(motionName);
    if (expressionName) entry.expressions.add(expressionName);
  };

  for (const root of commands) {
    for (const command of commandsIncludingTimelineEpisodes(root)) {
      const opcode = Number(command.command);
      const targets = commandTargetNames(command, separator);
      const model = hasAdvCharacterModel(command.characterModel)
        ? command.characterModel
        : undefined;
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
          const selected =
            model || variants.get(target)?.get(selectedIndex);
          if (!selected) continue;
          activeModels.set(target, selected);
          selectedIndices.set(target, selectedIndex);
          recordCommandAnimations(command, selected);
        }
        continue;
      }

      for (const target of targets) {
        const active = activeModels.get(target);
        if (active) recordCommandAnimations(command, active);
      }
    }
  }
  return usage;
}

function commandTargetNames(
  command: AdvCommand,
  separator: string,
): string[] {
  const explicit = (command.targets || [])
    .map((entry) => stringValue(entry?.target))
    .filter(Boolean);
  return explicit.length
    ? [...new Set(explicit)]
    : splitAdvTargetNames(command.targetName, separator);
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

function staticPortraitSource(character: AdvCharacterModelEntry): string {
  const source = character as Record<string, unknown>;
  const runtime =
    source.runtime &&
    typeof source.runtime === "object" &&
    !Array.isArray(source.runtime)
      ? (source.runtime as Record<string, unknown>)
      : {};
  const explicitImage = firstStringValue(runtime.imageUrl, source.imageUrl);
  if (explicitImage) return explicitImage;
  if (
    firstStringValue(runtime.format, source.format).toLowerCase() !==
    "static-portrait"
  ) {
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

function preloadConcurrency(value: unknown, fallback = 8, max = 16) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(number)));
}

function preloadWindow(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

/**
 * Native `PreloadFromTimeline` traverses the AdvEpisodeSignal rows
 * and preloads their command resources at the parent Timeline command's
 * position. Recursive Timeline episodes are rejected by the native helper.
 */
function commandsIncludingTimelineEpisodes(command: AdvCommand): AdvCommand[] {
  const commands: AdvCommand[] = [];
  const seen = new Set<AdvCommand>();
  const visit = (entry: AdvCommand): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    commands.push(entry);
    for (const nested of advCommandGroupCommands(entry)) visit(nested);
    for (const signal of sortAdvTimelineSignals(
      entry.timeline?.signals || [],
    )) {
      if (Number(signal.episode?.command) !== 45) visit(signal.episode);
    }
  };
  visit(command);
  return commands;
}
