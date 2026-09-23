import { narrativePositionAtBoundary, resolveNarrativePosition } from "../narrative/position";
import type {
  VegaBacklogEntry,
  VegaJsonValue,
  VegaNarrativeSettings,
  VegaSaveData,
  VegaUnlockKind,
} from "@haneoka/vega-protocol";
import { VEGA_SYSTEM_OPCODE } from "@haneoka/vega-protocol";
import type { AdvPlayer } from "../core/AdvPlayer";
import type { AdvStorySceneSeekSnapshot } from "../rendering/neutral/StorySceneSnapshot";
import { resolveStoryLocalizedText } from "../runtime";
import type { AdvSoundSnapshot } from "../sound/AdvSoundManager";
import type { AdvCommand, AdvStory } from "../types/AdvRuntime";
import { VegaMemorySaveStorage, VegaSaveRepository, type VegaSaveStorage } from "../narrative/save";
import { DEFAULT_NARRATIVE_SETTINGS, VegaNarrativeStore } from "../narrative/state";
import type { VegaDisposable } from "../engine/lifecycle";
import type {
  VegaShellController,
  VegaShellFlowEdge,
  VegaShellFlowNode,
  VegaShellGalleryItem,
  VegaShellScreen,
  VegaShellSnapshot,
} from "./contracts";

const CORE_ENGINE_VERSION = "0.1.0";
const QUICK_SAVE_SLOT = "quick";

export interface VegaShellControllerOptions {
  readonly player: AdvPlayer;
  readonly story: AdvStory;
  readonly narrativeStore: VegaNarrativeStore;
  readonly storage?: VegaSaveStorage;
  readonly projectId?: string;
  readonly settingsId?: string;
  readonly initialSettings?: Partial<VegaNarrativeSettings>;
  readonly title?: string;
  readonly initialScreen?: "title" | "game";
  readonly root?: HTMLElement;
  readonly signal?: AbortSignal;
  readonly onExitRequest?: () => void | Promise<void>;
}

export interface VegaManagedShellController extends VegaShellController {
  dispose(): void;
}

export const createVegaShellController = async (
  options: VegaShellControllerOptions,
): Promise<VegaManagedShellController> => {
  const controller = new DefaultVegaShellController(options);
  await controller.initialize();
  return controller;
};

class DefaultVegaShellController implements VegaManagedShellController {
  private readonly player: AdvPlayer;
  private readonly story: AdvStory;
  private readonly narrative: VegaNarrativeStore;
  private readonly repository: VegaSaveRepository;
  private readonly settingsStorage: VegaSaveStorage;
  private readonly settingsKey: string;
  private readonly initialSettings?: Partial<VegaNarrativeSettings>;
  private settingsWriteTail: Promise<void> = Promise.resolve();
  private readonly projectId: string;
  private readonly projectFormatVersion: number;
  private readonly title: string;
  private readonly root?: HTMLElement;
  private readonly signal?: AbortSignal;
  private readonly onExitRequest?: () => void | Promise<void>;
  private readonly listeners = new Set<(snapshot: VegaShellSnapshot) => void>();
  private readonly sceneMarkers: readonly (VegaShellFlowNode & {
    index: number;
  })[];
  private readonly flowEdges: readonly VegaShellFlowEdge[];
  private readonly galleryEntries: readonly {
    id: string;
    kind: VegaUnlockKind;
    title: string;
    thumbnail?: string;
    source?: string;
  }[];
  private readonly removeExecutionObserver: () => void;
  private saves: readonly VegaSaveData[] = [];
  private screen: VegaShellScreen = "title";
  private returnScreen: "title" | "game" | undefined;
  private hasStarted = false;
  private backlogSequence = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: VegaShellControllerOptions) {
    this.screen = options.initialScreen ?? "title";
    this.player = options.player;
    this.story = options.story;
    this.narrative = options.narrativeStore;
    this.root = options.root;
    this.signal = options.signal;
    this.onExitRequest = options.onExitRequest;
    const project = record(options.story.vegaProject);
    this.projectId = options.projectId?.trim() || text(project.id) || text(options.story.id) || "vega-story";
    this.projectFormatVersion = positiveInteger(project.formatVersion, 1);
    this.title =
      options.title?.trim() ||
      this.player.resolveLocalizedText(project.title ?? options.story.title ?? options.story.name ?? this.projectId)
        .text ||
      this.projectId;
    this.settingsStorage = options.storage ?? new VegaMemorySaveStorage();
    this.settingsKey = `vega:${encodeURIComponent(options.settingsId || this.projectId)}:settings`;
    this.initialSettings = options.initialSettings;
    this.repository = new VegaSaveRepository({
      projectId: this.projectId,
      projectFormatVersion: this.projectFormatVersion,
      engineVersion: CORE_ENGINE_VERSION,
      storage: this.settingsStorage,
    });
    this.sceneMarkers = sceneMarkers(options.story, this.player.resolveLocalizedText);
    this.flowEdges = deriveVegaShellFlowEdges(options.story);
    this.galleryEntries = galleryEntries(options.story, this.player.resolveLocalizedText);
    this.removeExecutionObserver = this.player.subscribeExecutionObserver((boundary) => {
      if (boundary.phase !== "after" || this.disposed) return;
      this.captureBacklog(boundary.commandIndex, boundary.command);
      this.notify();
    });
    options.signal?.addEventListener("abort", () => this.dispose(), {
      once: true,
    });
  }

  async initialize(): Promise<void> {
    this.assertActive();
    let settings = this.initialSettings;
    try {
      const saved = await this.settingsStorage.read(this.settingsKey);
      const parsed: unknown = saved ? JSON.parse(saved) : undefined;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Partial<VegaNarrativeSettings>;
      }
    } catch {
      /* Unavailable storage does not prevent playback. */
    }
    for (const key of Object.keys(DEFAULT_NARRATIVE_SETTINGS) as Array<keyof VegaNarrativeSettings>) {
      const value = settings?.[key];
      if (value !== undefined) this.narrative.setSetting(key, value);
    }
    this.saves = await this.repository.list();
    this.applySettings();
  }

  snapshot(): VegaShellSnapshot {
    const narrative = this.narrative.snapshot();
    const currentScene = this.sceneAt(this.player.currentProgressIndex());
    return {
      projectId: this.projectId,
      title: this.title,
      screen: this.screen,
      navigationOrigin:
        this.screen === "title"
          ? "title"
          : this.screen === "game"
            ? "game"
            : (this.returnScreen ?? (this.hasStarted ? "game" : "title")),
      canContinue: this.saves.length > 0,
      paused: this.player.state.paused,
      autoPlay: this.player.state.autoPlay,
      fastForward: this.player.state.fastForward,
      settings: { ...narrative.settings },
      saves: this.saves.map((save) => clone(save)),
      backlog: narrative.backlog.map((entry) => ({
        ...clone(entry),
        ...(entry.textSources
          ? { text: entry.textSources.map((value) => this.player.resolveLocalizedText(value).text).join("") }
          : entry.textSource === undefined
            ? {}
            : { text: this.player.resolveLocalizedText(entry.textSource).text }),
        ...(entry.speakerSources === undefined
          ? {}
          : {
              speaker: entry.speakerSources
                .map((value) => this.player.resolveLocalizedText(value).text)
                .filter(Boolean)
                .join(entry.speakerSeparator ?? "・"),
            }),
      })),
      gallery: this.galleryEntries.map((entry): VegaShellGalleryItem => ({
        ...entry,
        unlocked: this.narrative.isUnlocked(entry.kind, entry.id),
      })),
      flow: this.sceneMarkers.map((marker): VegaShellFlowNode => ({
        id: marker.id,
        label: marker.label,
        sceneId: marker.id,
        visited: this.narrative.isUnlocked("scene", marker.id) || narrative.visitedFlowNodes.includes(marker.id),
        current: marker.id === currentScene,
        ...(marker.chapter ? { chapter: marker.chapter } : {}),
        ...(marker.thumbnail ? { thumbnail: marker.thumbnail } : {}),
        ...(marker.description ? { description: marker.description } : {}),
      })),
      flowEdges: this.flowEdges.map((edge) => ({ ...edge })),
    };
  }

  subscribe(listener: (snapshot: VegaShellSnapshot) => void): VegaDisposable {
    this.assertActive();
    this.listeners.add(listener);
    listener(this.snapshot());
    let subscribed = true;
    return {
      dispose: () => {
        if (!subscribed) return;
        subscribed = false;
        this.listeners.delete(listener);
      },
    };
  }

  start(): Promise<void> {
    return this.enqueue(() => this.startNow());
  }

  continue(): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshSaves();
      const latest = this.saves[0];
      if (latest) await this.loadNow(latest.slot);
      else await this.startNow();
    });
  }

  resume(): void {
    this.assertActive();
    this.returnScreen = undefined;
    this.screen = "game";
    this.hasStarted = true;
    this.player.resume();
    this.playInBackground();
    this.notify();
  }

  enterGame(): void {
    this.assertActive();
    const changed = this.screen !== "game" || !this.hasStarted;
    this.returnScreen = undefined;
    this.screen = "game";
    this.hasStarted = true;
    if (changed) this.notify();
  }

  pause(): void {
    this.assertActive();
    this.player.pause();
    this.notify();
  }

  open(screen: Exclude<VegaShellScreen, "game">): void {
    this.assertActive();
    if (screen === this.screen) return;
    this.player.pause();
    if (this.screen === "title" || this.screen === "game") {
      this.returnScreen = this.screen;
    }
    this.screen = screen;
    this.notify();
  }

  close(): void {
    this.assertActive();
    if (this.screen === "title") return;
    this.screen = this.returnScreen ?? (this.hasStarted ? "game" : "title");
    this.returnScreen = undefined;
    if (this.screen === "game") {
      this.player.resume();
      this.playInBackground();
    } else {
      this.player.pause();
    }
    this.notify();
  }

  save(slot: string, label?: string): Promise<void> {
    return this.enqueue(async () => {
      const pendingSeek = this.player.activeSeek?.completion;
      if (pendingSeek) await pendingSeek;
      this.assertActive();
      const commandIndex = this.player.currentProgressIndex();
      const stage = jsonValue(this.player.SceneRoot.createSeekSnapshot());
      const audio = jsonValue(this.player.SoundManager.createSnapshot());
      const latestLine = this.player.state.talk?.visible
        ? this.player.state.talk
        : this.narrative.snapshot().backlog.at(-1);
      const previewImage = await captureStagePreview(this.player.SceneRoot, this.root);
      await this.repository.save(
        slot,
        narrativePositionAtBoundary(this.story.commands ?? [], commandIndex, (index) => this.sceneAt(index)),
        this.narrative,
        {
          commandIndex,
          choicePositions: [...this.player.exportSeekDecisions()].map(([index, value]) => ({
            position: narrativePositionAtBoundary(this.story.commands ?? [], index, (at) => this.sceneAt(at)),
            value: jsonValue(value) ?? null,
          })),
          choiceRecords: [...this.player.exportSeekDecisions()].map(
            ([index, value]) => [index, jsonValue(value) ?? null] as const,
          ),
          ...(stage === undefined ? {} : { stage }),
          ...(audio === undefined ? {} : { audio }),
        },
        label,
        {
          ...(latestLine?.speaker ? { speaker: latestLine.speaker } : {}),
          ...(latestLine?.text ? { text: latestLine.text } : {}),
          ...(previewImage ? { previewImage } : {}),
        },
      );
      await this.refreshSaves();
    });
  }

  load(slot: string): Promise<void> {
    return this.enqueue(() => this.loadNow(slot));
  }

  deleteSave(slot: string): Promise<void> {
    return this.enqueue(async () => {
      await this.repository.remove(slot);
      await this.refreshSaves();
    });
  }

  quickSave(): Promise<void> {
    return this.save(QUICK_SAVE_SLOT, "Quick save");
  }

  quickLoad(): Promise<void> {
    return this.load(QUICK_SAVE_SLOT);
  }

  setSetting<K extends keyof VegaNarrativeSettings>(key: K, value: VegaNarrativeSettings[K]): void {
    this.assertActive();
    this.narrative.setSetting(key, value);
    const serialized = JSON.stringify(this.narrative.settings);
    this.settingsWriteTail = this.settingsWriteTail
      .then(() => this.settingsStorage.write(this.settingsKey, serialized))
      .catch((error: unknown) => console.warn("[Vega] Could not persist settings", error));
    this.applySettings();
    this.notify();
  }

  jumpToBacklog(entryId: string): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.narrative.snapshot().backlog.find(({ id }) => id === entryId);
      if (!entry) throw new ReferenceError(`Vega backlog entry does not exist: ${entryId}`);
      await this.jumpTo(
        resolveNarrativePosition(
          this.story.commands ?? [],
          {
            sceneId: entry.sceneId,
            commandIndex: entry.commandIndex + 1,
            ...(entry.commandId ? { commandId: entry.commandId, boundary: "after" as const } : {}),
          },
          (index) => this.sceneAt(index),
        ),
      );
    });
  }

  jumpToFlowNode(nodeId: string): Promise<void> {
    return this.enqueue(async () => {
      const marker = this.sceneMarkers.find(({ id }) => id === nodeId);
      if (!marker) throw new ReferenceError(`Vega flow node does not exist: ${nodeId}`);
      const snapshot = this.snapshot();
      if (!snapshot.flow.find(({ id }) => id === nodeId)?.visited) {
        throw new Error(`Vega flow node has not been visited: ${nodeId}`);
      }
      await this.jumpTo(marker.index);
    });
  }

  toggleAuto(): void {
    this.assertActive();
    this.player.toggleAuto();
    this.notify();
  }

  toggleFastForward(): void {
    this.assertActive();
    this.player.toggleFast();
    this.notify();
  }

  returnToTitle(): Promise<void> {
    return this.enqueue(async () => {
      this.player.pause();
      this.returnScreen = undefined;
      this.hasStarted = false;
      this.screen = "title";
      this.notify();
    });
  }

  exit(): Promise<void> {
    return this.enqueue(async () => {
      this.player.pause();
      this.returnScreen = undefined;
      this.screen = "title";
      this.notify();
      // A browser library cannot close its host or navigate safely. The host
      // receives an explicit request when configured; otherwise exit is a
      // deliberate no-op after returning to the title screen.
      await this.onExitRequest?.();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeExecutionObserver();
    this.listeners.clear();
  }

  private async startNow(): Promise<void> {
    this.player.pause();
    this.narrative.reset({ preserveSettings: true, preserveUnlocks: true });
    this.player.importSeekDecisions();
    await this.player.replayFromStartTo(0);
    this.hasStarted = true;
    this.returnScreen = undefined;
    this.screen = "game";
    this.player.state.finished = false;
    this.applySettings();
    this.player.resume();
    this.notify();
    this.playInBackground();
  }

  private async loadNow(slot: string): Promise<void> {
    this.player.pause();
    const preferences = this.narrative.settings;
    const save = await this.repository.load(slot);
    if (!save) throw new ReferenceError(`Vega save slot does not exist: ${slot}`);
    const commandIndex = resolveNarrativePosition(this.story.commands ?? [], save.position, (index) =>
      this.sceneAt(index),
    );
    const decisions =
      save.player.choicePositions?.map(
        (entry) =>
          [
            resolveNarrativePosition(this.story.commands ?? [], entry.position, (index) => this.sceneAt(index)),
            entry.value,
          ] as const,
      ) ?? save.player.choiceRecords;
    const sourceNarrative = clone(save.narrative);
    const restoredNarrative = {
      ...sourceNarrative,
      sceneStack: sourceNarrative.sceneStack.map((frame) => {
        if (!frame.callerId) return frame;
        const index = resolveNarrativePosition(
          this.story.commands ?? [],
          {
            sceneId: frame.sceneId,
            commandId: frame.callerId,
            commandIndex: 0,
            boundary: "before",
          },
          (index) => this.sceneAt(index),
        );
        const returnKey = text(this.story.commands?.[index]?.returnKey);
        if (!returnKey) throw new Error(`Saved scene call has no return address: ${frame.sceneId}/${frame.callerId}`);
        return { ...frame, returnKey };
      }),
    };
    this.narrative.restore(restoredNarrative);
    this.player.importSeekDecisions(new Map(decisions as unknown as readonly (readonly [number, never])[]));
    await this.player.replayFromStartTo(commandIndex);
    // Deterministic visual replay necessarily executes system commands. The
    // serialized narrative state remains authoritative after reconstruction.
    this.narrative.restore({ ...restoredNarrative, settings: preferences });
    if (save.player.stage) {
      await this.player.SceneRoot.restoreSeekSnapshot(save.player.stage as unknown as AdvStorySceneSeekSnapshot);
    }
    if (save.player.audio) this.player.SoundManager.restoreSnapshot(save.player.audio as unknown as AdvSoundSnapshot);
    this.hasStarted = true;
    this.returnScreen = undefined;
    this.screen = "game";
    this.player.state.finished = false;
    this.applySettings(true);
    this.player.holdRestoredDialogue();
    this.player.resume();
    await this.refreshSaves();
    this.playInBackground();
  }

  private async jumpTo(commandIndex: number): Promise<void> {
    this.player.pause();
    await this.player.replayFromStartTo(commandIndex);
    this.hasStarted = true;
    this.returnScreen = undefined;
    this.screen = "game";
    this.player.resume();
    this.notify();
    this.playInBackground();
  }

  private captureBacklog(commandIndex: number, authored: AdvCommand): void {
    if (Number(authored.command) !== 2) return;
    const command = this.player.state.currentCommand ?? authored;
    const presentation = this.player.state.talk.sourceCommand ?? command;
    const { text: resolvedText, speaker: resolvedSpeaker } = this.player.resolveDialogue(presentation);
    if (!resolvedText.text) return;
    const speaker = resolvedSpeaker.text;
    const sources = this.player.dialogueSources(presentation);
    const voices = Array.isArray(command.voices) ? command.voices : [];
    const voice = text(record(voices[0]).playableUrl ?? record(voices[0]).url);
    const entry: VegaBacklogEntry = {
      id: `${this.sceneAt(commandIndex)}:${commandIndex}:${++this.backlogSequence}`,
      sceneId: this.sceneAt(commandIndex),
      commandIndex,
      ...(typeof authored.commandId === "string" && authored.commandId ? { commandId: authored.commandId } : {}),
      speaker,
      text: resolvedText.text,
      textSources: sources.texts.map((value) => jsonValue(value) ?? null),
      speakerSources: sources.speakers.map((value) => jsonValue(value) ?? null),
      speakerSeparator: sources.separator,
      ...(voice ? { voice } : {}),
      createdAt: new Date().toISOString(),
    };
    this.narrative.appendBacklog(entry);
    this.narrative.markRead(`${entry.sceneId}:${entry.commandId ?? commandIndex}`);
  }

  private applySettings(refreshLocale = false): void {
    const settings = this.narrative.settings;
    this.player.setLocale(settings.language, { refresh: refreshLocale });
    this.player.setTextSpeed(settings.textSpeed);
    this.player.setAutoPlayDelaySeconds(settings.autoDelay);
    const instantText = Boolean(settings.instantText);
    if (instantText && !this.player.state.instantText) this.player.Model.currentTypingController?.finish();
    this.player.state.instantText = instantText;
    if (this.player.Model.isSubtitlesEnabled !== (settings.subtitlesEnabled !== false)) {
      this.player.setSubtitlesEnabled(settings.subtitlesEnabled !== false);
    }
    this.player.SoundManager.setMasterVolume(settings.masterVolume);
    this.player.SoundManager.setUserCategoryVolume("Bgm", settings.bgmEnabled === false ? 0 : settings.bgmVolume);
    this.player.SoundManager.setUserCategoryVolume("Voice", settings.voiceVolume);
    this.player.SoundManager.setUserCategoryVolume("Se", settings.seVolume);
    if (this.root?.dataset) {
      this.root.dataset.vegaReducedMotion = String(settings.reducedMotion);
      this.root.dataset.vegaHighContrast = String(settings.highContrast);
      this.root.style.setProperty("--vega-text-size", String(settings.textSize ?? 1));
      this.root.lang = settings.uiLanguage === "auto" ? "" : settings.uiLanguage;
    }
  }

  private sceneAt(commandIndex: number): string {
    let current = this.sceneMarkers[0]?.id || "main";
    for (const marker of this.sceneMarkers) {
      if (marker.index > commandIndex) break;
      current = marker.id;
    }
    return current;
  }

  private async refreshSaves(): Promise<void> {
    this.saves = await this.repository.list();
    this.notify();
  }

  private playInBackground(): void {
    if (this.player.state.playing || this.player.disposed) return;
    void this.player.play().catch((error: unknown) => {
      if (!this.disposed) this.player.state.error = error instanceof Error ? error.message : String(error);
    });
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const result = this.operationTail.then(() => {
      this.assertActive();
      return operation();
    });
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private notify(): void {
    if (this.disposed) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.player.state.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  private assertActive(): void {
    if (this.disposed || this.signal?.aborted) throw new ReferenceError("Vega shell controller is disposed");
  }
}

const captureStagePreview = async (
  scene: AdvPlayer["SceneRoot"],
  root: HTMLElement | undefined,
): Promise<string | undefined> => {
  try {
    const captured = await scene.capturePreview?.({
      width: 480,
      height: 270,
      format: "image/webp",
      quality: 0.55,
    });
    if (captured) return captured;
  } catch {
    // Renderer-owned capture is optional. A scoped canvas fallback still lets
    // simple browser renderers provide previews without coupling core to them.
  }
  if (!root || typeof root.querySelector !== "function") return undefined;
  const stage = root.querySelector<HTMLElement>("[data-vega-stage-host]");
  if (!stage) return undefined;
  const candidates = [...stage.querySelectorAll("canvas")].filter((canvas) => canvas.width > 0 && canvas.height > 0);
  const source = candidates.sort((left, right) => right.width * right.height - left.width * left.height)[0];
  const document = root.ownerDocument;
  if (!source || !document?.createElement) return undefined;
  try {
    const preview = document.createElement("canvas");
    preview.width = 480;
    preview.height = 270;
    const context = preview.getContext("2d");
    if (!context) return undefined;
    const scale = Math.max(preview.width / source.width, preview.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.drawImage(source, (preview.width - width) / 2, (preview.height - height) / 2, width, height);
    return preview.toDataURL("image/webp", 0.55);
  } catch {
    // Cross-origin or host-provided canvases may be unreadable. The shell can
    // still fall back to renderer-neutral stage metadata from the save.
    return undefined;
  }
};

const sceneMarkers = (
  story: AdvStory,
  resolve = resolveStoryLocalizedText,
): readonly (VegaShellFlowNode & { index: number })[] => {
  const markers = (story.commands ?? []).flatMap((command, index) => {
    if (Number(command.command) !== VEGA_SYSTEM_OPCODE.SceneMarker || command.returnMarker) return [];
    const id = text(command.sceneId);
    if (!id) return [];
    const chapter = resolve(command.chapter ?? "").text;
    const description = resolve(command.description ?? "").text;
    const thumbnail = text(command.thumbnail);
    return [
      {
        id,
        index,
        sceneId: id,
        visited: false,
        current: false,
        label: resolve(command.title ?? id).text || id,
        ...(chapter ? { chapter } : {}),
        ...(description ? { description } : {}),
        ...(thumbnail ? { thumbnail } : {}),
      },
    ];
  });
  if (markers.length) return markers;
  const project = record(story.vegaProject);
  const entry = text(project.entryScene) || "main";
  return [
    {
      id: entry,
      index: 0,
      sceneId: entry,
      visited: false,
      current: false,
      label: entry,
    },
  ];
};

const galleryEntries = (
  story: AdvStory,
  resolve = resolveStoryLocalizedText,
): readonly {
  id: string;
  kind: VegaUnlockKind;
  title: string;
  thumbnail?: string;
  source?: string;
}[] => {
  const assets = record(story.vegaAssets);
  return Object.entries(assets).flatMap(([id, raw]) => {
    const asset = record(raw);
    const type = text(asset.type);
    const kind: VegaUnlockKind | undefined = type === "audio" ? "bgm" : type === "image" ? "cg" : undefined;
    if (!kind) return [];
    const source = text(asset.source);
    return [
      {
        id,
        kind,
        title: resolve(asset.title ?? id).text || id,
        ...(source ? { source, ...(kind === "cg" ? { thumbnail: source } : {}) } : {}),
      },
    ];
  });
};

export const deriveVegaShellFlowEdges = (story: AdvStory): readonly VegaShellFlowEdge[] => {
  const edges: VegaShellFlowEdge[] = [];
  const unique = new Set<string>();
  let currentScene = text(record(story.vegaProject).entryScene) || "main";
  const add = (edge: VegaShellFlowEdge): void => {
    if (!edge.from || !edge.to) return;
    const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}\u0000${edge.condition ?? ""}`;
    if (unique.has(key)) return;
    unique.add(key);
    edges.push(edge);
  };
  for (const command of story.commands ?? []) {
    const opcode = Number(command.command);
    if (opcode === VEGA_SYSTEM_OPCODE.SceneMarker && !command.returnMarker) {
      currentScene = text(command.sceneId) || currentScene;
      continue;
    }
    if (opcode === VEGA_SYSTEM_OPCODE.JumpScene || opcode === VEGA_SYSTEM_OPCODE.CallScene) {
      const to = text(command.sceneId);
      if (to) {
        add({
          from: text(command.sceneSource) || currentScene,
          to,
          kind: opcode === VEGA_SYSTEM_OPCODE.JumpScene ? "jump" : "call",
        });
      }
      continue;
    }
    if (opcode === VEGA_SYSTEM_OPCODE.Branch) {
      const from = text(command.sceneSource) || currentScene;
      const condition = text(command.condition);
      const thenScene = text(command.thenScene);
      const elseScene = text(command.elseScene);
      if (thenScene)
        add({
          from,
          to: thenScene,
          kind: "branch",
          ...(condition ? { condition } : {}),
        });
      if (elseScene) {
        add({
          from,
          to: elseScene,
          kind: "branch",
          ...(condition ? { condition: `!(${condition})` } : {}),
        });
      }
    }
  }
  return edges;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const positiveInteger = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
};

const jsonValue = (value: unknown): VegaJsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    return clone(value) as VegaJsonValue;
  } catch {
    return undefined;
  }
};

const clone = <T>(value: T): T => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
};
