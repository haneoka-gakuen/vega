import type {
  VegaJsonValue,
  VegaPreviewBreakpoint,
  VegaPreviewBreakpointResult,
  VegaPreviewCapabilities,
  VegaPreviewIdentity,
  VegaPreviewReferenceFrameResult,
  VegaPreviewRequest,
  VegaPreviewResponse,
  VegaPreviewStageSnapshot,
  VegaPreviewTransform,
  VegaPreviewTransformResult,
} from "@haneoka/vega-protocol";
import { VEGA_PREVIEW_PROTOCOL, isVegaPreviewRequest } from "@haneoka/vega-protocol";
import type { AdvPlayerExecutionBoundary } from "../core/AdvPlayer";
import type { StoryCameraState } from "../rendering/StorySceneBackend";
import type { AdvCommand, AdvStory } from "../types/AdvRuntime";
import type { VegaPlayerHandle } from "./VegaEngine";
import { VegaEngine } from "./VegaEngine";

const CAPABILITIES: VegaPreviewCapabilities = Object.freeze({
  commands: [
    "runtime.load",
    "runtime.play",
    "runtime.pause",
    "runtime.seek",
    "runtime.snapshot",
    "runtime.dispose",
    "editor.sync-scene",
    "editor.run-scene",
    "editor.run-from",
    "editor.run-snippet",
    "debug.continue",
    "debug.step",
    "debug.breakpoints.set",
    "debug.variables",
    "stage.snapshot",
    "stage.reference-frame",
    "stage.transform.get",
    "stage.transform.set",
  ] as const,
  stageInspection: true,
  patching: false,
  revisionCancellation: true,
  debugging: true,
  stageTransforms: true,
  transports: ["message-port"] as const,
});

type StopReason = "pause" | "breakpoint" | "step" | "end";

export interface VegaPreviewRuntimeOptions {
  readonly identity: VegaPreviewIdentity;
  readonly mount: HTMLElement;
  readonly port: MessagePort;
  readonly engine?: VegaEngine;
  /** Theme contribution id selected for every preview player. */
  readonly theme?: string | false;
  /** Render contribution id or backend selected for every preview player. */
  readonly renderBackend?: string;
  readonly maxPayloadBytes?: number;
}

/**
 * Isolated preview runtime. A MessagePort must be transferred during a
 * separately authenticated bootstrap; this class never accepts wildcard
 * window messages itself.
 */
export class VegaPreviewRuntime {
  readonly identity: VegaPreviewIdentity;
  readonly port: MessagePort;
  readonly engine: VegaEngine;
  private readonly mount: HTMLElement;
  private readonly theme: string | false | undefined;
  private readonly renderBackend: string | undefined;
  private readonly ownsEngine: boolean;
  private readonly maxPayloadBytes: number;
  private player: VegaPlayerHandle | null = null;
  private syncedStory: AdvStory | null = null;
  private sceneId = "runtime";
  private sceneRevision = "0";
  private breakpoints: readonly VegaPreviewBreakpoint[] = [];
  private latestRevision = -1;
  private operationTail: Promise<void> = Promise.resolve();
  private activeOperation: AbortController | null = null;
  private playTask: Promise<void> | null = null;
  private stepPending = false;
  private skipBreakpointOnce: number | null = null;
  private pausedBoundaryIndex: number | null = null;
  private stateEventQueued = false;
  private stateEventGeneration = 0;
  private replacingRevision: number | null = null;
  private startPromise: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private acceptingRequests = true;
  private disposed = false;

  constructor(options: VegaPreviewRuntimeOptions) {
    this.identity = options.identity;
    this.mount = options.mount;
    this.port = options.port;
    this.engine = options.engine ?? new VegaEngine({ id: options.identity.runtimeInstanceId });
    this.theme = options.theme;
    this.renderBackend = options.renderBackend;
    this.ownsEngine = !options.engine;
    this.maxPayloadBytes = options.maxPayloadBytes ?? 8 * 1024 * 1024;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (!this.acceptingRequests || this.disposed) {
      return Promise.reject(new ReferenceError("Cannot start a disposed Vega preview runtime"));
    }
    this.startPromise = (async () => {
      await this.engine.start();
      if (!this.acceptingRequests || this.disposed) return;
      this.port.addEventListener("message", this.onMessage);
      this.port.start();
      this.port.postMessage({
        protocol: VEGA_PREVIEW_PROTOCOL,
        kind: "event",
        event: "runtime.ready",
        identity: this.identity,
        capabilities: CAPABILITIES,
      });
    })();
    return this.startPromise;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.acceptingRequests = false;
    this.activeOperation?.abort();
    this.port.removeEventListener("message", this.onMessage);
    const pending = this.operationTail;
    this.disposal = (async () => {
      await this.startPromise?.catch(() => undefined);
      await pending.catch(() => undefined);
      await this.player?.dispose();
      this.player = null;
      this.syncedStory = null;
      if (this.ownsEngine) await this.engine.dispose();
      this.port.close();
      this.disposed = true;
    })();
    return this.disposal;
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (!this.acceptingRequests || this.disposed || !isVegaPreviewRequest(event.data)) return;
    this.enqueue(event.data);
  };

  private enqueue(request: VegaPreviewRequest): void {
    if (!this.matchesIdentity(request.identity)) return this.reject(request, "identity", "Preview identity mismatch");
    let payloadSize: number;
    try {
      payloadSize = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    } catch {
      return this.reject(request, "invalid-payload", "Preview payload is not serializable");
    }
    if (payloadSize > this.maxPayloadBytes)
      return this.reject(request, "payload-too-large", "Preview payload too large");
    if (request.revision < this.latestRevision) {
      return this.respond(request, { status: "superseded" });
    }
    if (request.revision > this.latestRevision) {
      this.latestRevision = request.revision;
      this.activeOperation?.abort();
    }
    if (this.replacesPlayer(request)) {
      this.stateEventGeneration += 1;
      this.replacingRevision = request.revision;
      this.player?.player.pause();
    }
    if (request.command.name === "runtime.dispose") this.acceptingRequests = false;
    const operation = this.operationTail.then(() => this.execute(request));
    this.operationTail = operation.catch(() => undefined);
  }

  private async execute(request: VegaPreviewRequest): Promise<void> {
    if (request.revision < this.latestRevision) {
      this.respond(request, { status: "superseded" });
      return;
    }
    const operation = new AbortController();
    this.activeOperation = operation;
    try {
      let result: VegaJsonValue | undefined;
      switch (request.command.name) {
        case "runtime.load": {
          const loaded = await this.replacePlayer(
            request,
            request.command.story as unknown as AdvStory,
            request.command.commandIndex,
            { sceneId: "runtime", sceneRevision: String(request.revision) },
            operation.signal,
          );
          if (!loaded) return this.respond(request, { status: "superseded" });
          break;
        }
        case "editor.sync-scene": {
          const loaded =
            this.player &&
            this.sceneId === request.command.sceneId &&
            this.sceneRevision === request.command.sceneRevision
              ? await this.seekPlayer(request, request.command.commandIndex ?? 0, operation.signal)
              : await this.replacePlayer(
                  request,
                  request.command.story as unknown as AdvStory,
                  request.command.commandIndex,
                  { sceneId: request.command.sceneId, sceneRevision: request.command.sceneRevision },
                  operation.signal,
                );
          if (!loaded) return this.respond(request, { status: "superseded" });
          result = {
            sceneId: this.sceneId,
            sceneRevision: this.sceneRevision,
            commandIndex: this.requirePlayer().player.currentProgressIndex(),
          };
          break;
        }
        case "editor.run-scene": {
          const loaded = await this.seekPlayer(request, request.command.commandIndex ?? 0, operation.signal);
          if (!loaded) return this.respond(request, { status: "superseded" });
          this.continuePlayback(false);
          result = { sceneId: this.sceneId, commandIndex: this.requirePlayer().player.currentProgressIndex() };
          break;
        }
        case "editor.run-from":
        case "runtime.seek": {
          const loaded = await this.seekPlayer(request, request.command.commandIndex, operation.signal);
          if (!loaded) return this.respond(request, { status: "superseded" });
          if (request.command.name === "editor.run-from") this.continuePlayback(false);
          result = { sceneId: this.sceneId, commandIndex: this.requirePlayer().player.currentProgressIndex() };
          break;
        }
        case "editor.run-snippet": {
          const commands = requireSnippetCommands(request.command.commands);
          const handle = this.requirePlayer();
          handle.shell?.enterGame();
          await handle.player.executePreviewCommands(commands, operation.signal);
          result = { executedCommands: commands.length, label: request.command.label ?? "" };
          this.scheduleStateEvent();
          break;
        }
        case "runtime.play":
        case "debug.continue":
          this.continuePlayback();
          result = { commandIndex: this.requirePlayer().player.currentProgressIndex() };
          break;
        case "runtime.pause":
          this.pausePlayback();
          result = { commandIndex: this.requirePlayer().player.currentProgressIndex() };
          break;
        case "debug.step":
          this.stepPlayback();
          result = { commandIndex: this.requirePlayer().player.currentProgressIndex() };
          break;
        case "debug.breakpoints.set":
          this.breakpoints = request.command.breakpoints.filter((breakpoint) => breakpoint.enabled !== false);
          result = this.breakpointResult() as unknown as VegaJsonValue;
          this.scheduleStateEvent();
          break;
        case "debug.variables":
          result = snapshotState(this.requirePlayer().player.narrativeStore.snapshot().variables);
          break;
        case "runtime.snapshot":
          result = snapshotState(this.requirePlayer().player.state);
          break;
        case "stage.snapshot":
          result = this.stageSnapshot();
          break;
        case "stage.reference-frame":
          result = this.referenceFrame(request.command.target) as unknown as VegaJsonValue;
          break;
        case "stage.transform.get":
          result = this.transformFor(request.command.target) as unknown as VegaJsonValue;
          break;
        case "stage.transform.set":
          result = this.setTransform(
            request.command.target,
            request.command.transform,
            request.command.phase ?? "commit",
          ) as unknown as VegaJsonValue;
          this.scheduleStateEvent();
          break;
        case "runtime.dispose": {
          this.respond(request, { status: "executed" });
          queueMicrotask(() => {
            void this.dispose().catch(() => undefined);
          });
          return;
        }
        case "runtime.patch":
          return this.reject(request, "unsupported", "Runtime patching is not enabled by this build");
      }
      if (operation.signal.aborted || request.revision < this.latestRevision) {
        return this.respond(request, { status: "superseded" });
      }
      this.respond(request, { status: "executed", result });
    } catch (error) {
      if (operation.signal.aborted || request.revision < this.latestRevision) {
        this.respond(request, { status: "superseded" });
      } else {
        this.reject(request, "execution", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.activeOperation === operation) this.activeOperation = null;
      if (this.replacesPlayer(request) && this.replacingRevision === request.revision) {
        this.replacingRevision = null;
        this.scheduleStateEvent();
      }
    }
  }

  private async seekPlayer(request: VegaPreviewRequest, index: number, signal: AbortSignal): Promise<boolean> {
    const handle = this.requirePlayer(),
      playback = this.playTask;
    this.stepPending = false;
    this.skipBreakpointOnce = null;
    this.pausedBoundaryIndex = null;
    handle.player.pause();
    await handle.player.seekTo(index, { resume: false });
    await playback?.catch(() => undefined);
    if (signal.aborted || request.revision < this.latestRevision) return false;
    handle.shell?.enterGame();
    this.pausedBoundaryIndex = handle.player.currentProgressIndex();
    if (this.replacingRevision === request.revision) this.replacingRevision = null;
    this.scheduleStateEvent();
    return true;
  }

  private async replacePlayer(
    request: VegaPreviewRequest,
    story: AdvStory,
    commandIndex: number | undefined,
    scene: { readonly sceneId: string; readonly sceneRevision: string },
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!story || typeof story !== "object" || Array.isArray(story)) {
      throw new TypeError("Preview story must be an object");
    }
    const seekDecisions = story === this.syncedStory && this.player ? this.player.player.exportSeekDecisions() : null;
    const next = await this.engine.createPlayer({
      mount: this.mount,
      story,
      ...(this.theme === undefined ? {} : { theme: this.theme }),
      ...(this.renderBackend ? { renderBackend: this.renderBackend } : {}),
    });
    next.player.subscribeExecutionObserver((boundary) => this.observeExecutionBoundary(next, boundary));
    try {
      if (signal.aborted || request.revision < this.latestRevision) {
        await next.dispose();
        return false;
      }
      next.shell?.enterGame();
      if (seekDecisions) next.player.importSeekDecisions(seekDecisions);
      if (commandIndex != null) await next.player.replayFromStartTo(commandIndex);
      if (signal.aborted || request.revision < this.latestRevision) {
        await next.dispose();
        return false;
      }
    } catch (error) {
      await next.dispose().catch(() => undefined);
      throw error;
    }

    const previous = this.player;
    this.player = next;
    this.syncedStory = story;
    this.sceneId = scene.sceneId;
    this.sceneRevision = scene.sceneRevision;
    if (this.replacingRevision === request.revision) this.replacingRevision = null;
    this.playTask = null;
    this.stepPending = false;
    this.skipBreakpointOnce = null;
    this.pausedBoundaryIndex = null;
    if (previous) {
      try {
        await previous.dispose();
      } catch (error) {
        this.emitDiagnostic(
          "warning",
          "previous-player-dispose",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.scheduleStateEvent();
    return true;
  }

  private observeExecutionBoundary(handle: VegaPlayerHandle, boundary: AdvPlayerExecutionBoundary): void {
    if (this.player !== handle || this.disposed) return;
    if (boundary.phase === "before") {
      if (this.skipBreakpointOnce === boundary.commandIndex) {
        this.skipBreakpointOnce = null;
      } else if (this.hasBreakpoint(boundary.commandIndex)) {
        handle.player.pause();
        this.pausedBoundaryIndex = boundary.commandIndex;
        this.emitStopped("breakpoint", boundary.commandIndex);
      }
    }
    if (boundary.phase === "after" && this.stepPending) {
      this.stepPending = false;
      handle.player.pause();
      this.pausedBoundaryIndex = handle.player.currentProgressIndex();
      this.emitStopped("step", this.pausedBoundaryIndex);
    }
    this.scheduleStateEvent();
  }

  private continuePlayback(skipCurrentBreakpoint = true): void {
    const handle = this.requirePlayer();
    handle.shell?.enterGame();
    if (skipCurrentBreakpoint && !handle.player.state.playing && handle.player.state.paused) {
      this.skipBreakpointOnce = handle.player.currentProgressIndex();
    }
    this.stepPending = false;
    this.pausedBoundaryIndex = null;
    handle.player.resume();
    this.startPlayback(handle);
    this.scheduleStateEvent();
  }

  private pausePlayback(): void {
    const handle = this.requirePlayer();
    handle.player.pause();
    this.pausedBoundaryIndex = handle.player.currentProgressIndex();
    this.emitStopped("pause", this.pausedBoundaryIndex);
    this.scheduleStateEvent();
  }

  private stepPlayback(): void {
    const handle = this.requirePlayer();
    handle.shell?.enterGame();
    const index = handle.player.currentProgressIndex();
    if (index >= (handle.player.story.commands?.length ?? 0)) {
      this.emitStopped("end", index);
      return;
    }
    if (!handle.player.state.playing) this.skipBreakpointOnce = index;
    this.stepPending = true;
    this.pausedBoundaryIndex = null;
    handle.player.resume();
    this.startPlayback(handle);
    this.scheduleStateEvent();
  }

  private startPlayback(handle: VegaPlayerHandle): void {
    if (handle.player.state.playing) return;
    const playback = handle.player.play();
    this.playTask = playback;
    void playback.then(
      () => {
        if (this.player !== handle || this.disposed) return;
        if (this.playTask === playback) this.playTask = null;
        this.stepPending = false;
        this.scheduleStateEvent();
        if (handle.player.state.finished) {
          this.emitStopped("end", handle.player.currentProgressIndex());
        }
      },
      (error) => {
        if (this.player !== handle || this.disposed) return;
        if (this.playTask === playback) this.playTask = null;
        this.stepPending = false;
        this.emitDiagnostic("error", "playback", error instanceof Error ? error.message : String(error));
        this.scheduleStateEvent();
      },
    );
  }

  private breakpointResult(): VegaPreviewBreakpointResult {
    return {
      sceneId: this.sceneId,
      breakpoints: this.breakpoints
        .filter((breakpoint) => !breakpoint.sceneId || breakpoint.sceneId === this.sceneId)
        .map((breakpoint) => breakpoint.commandIndex)
        .sort((left, right) => left - right),
    };
  }

  private hasBreakpoint(commandIndex: number): boolean {
    return this.breakpoints.some(
      (breakpoint) =>
        breakpoint.enabled !== false &&
        breakpoint.commandIndex === commandIndex &&
        (!breakpoint.sceneId || breakpoint.sceneId === this.sceneId),
    );
  }

  private stageSnapshot(): VegaJsonValue {
    const handle = this.requirePlayer();
    const narrative = handle.player.narrativeStore.snapshot();
    const snapshot: VegaPreviewStageSnapshot = {
      sceneId: this.sceneId,
      sceneRevision: this.sceneRevision,
      commandIndex: handle.player.currentProgressIndex(),
      commandCount: handle.player.story.commands?.length ?? 0,
      execution: {
        playing: handle.player.state.playing,
        paused: handle.player.state.paused,
        finished: handle.player.state.finished,
        seeking: handle.player.state.seeking,
        pausedBoundaryIndex: this.pausedBoundaryIndex,
        breakpoints: this.breakpointResult().breakpoints,
      },
      variables: snapshotState(narrative.variables),
      narrative: snapshotState(narrative),
      state: snapshotState(handle.player.state),
      camera: snapshotState(handle.player.SceneRoot.cameraState),
      targets: this.stageTargets(),
    };
    return snapshot as unknown as VegaJsonValue;
  }

  private referenceFrame(target: string): VegaPreviewReferenceFrameResult {
    const element = this.resolveTarget(target);
    if (!element) return { target, status: "missing", reason: `Stage target is not mounted: ${target}` };
    if (typeof element.getBoundingClientRect !== "function" || typeof this.mount.getBoundingClientRect !== "function") {
      return { target, status: "unsupported", reason: "The active renderer does not expose DOM reference frames" };
    }
    const stage = this.mount.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      target,
      status: "ready",
      frame: {
        originX: box.left - stage.left,
        originY: box.top - stage.top,
        width: box.width,
        height: box.height,
        anchorX: box.width / 2,
        anchorY: box.height / 2,
        stageWidth: stage.width,
        stageHeight: stage.height,
      },
    };
  }

  private transformFor(target: string): VegaPreviewTransformResult {
    const handle = this.requirePlayer();
    if (target === "camera" || target === "stage") {
      return {
        target,
        status: "ready",
        transform: cameraTransform(handle.player.SceneRoot.cameraState, this.resolveTarget("stage")),
      };
    }
    const element = this.resolveTarget(target);
    if (!element) return { target, status: "missing", reason: `Stage target is not mounted: ${target}` };
    return { target, status: "ready", transform: elementTransform(element) };
  }

  private setTransform(
    target: string,
    transform: VegaPreviewTransform,
    phase: "preview" | "commit",
  ): VegaPreviewTransformResult {
    const handle = this.requirePlayer();
    if (target === "camera" || target === "stage") {
      const camera = handle.player.SceneRoot.cameraState;
      if (transform.position) {
        camera.panOffsetX = transform.position.x;
        camera.panOffsetY = transform.position.y;
      }
      if (transform.scale) {
        if (Math.abs(transform.scale.x - transform.scale.y) > 0.000001) {
          throw new RangeError("The Vega stage camera supports uniform scale only");
        }
        if (transform.scale.x <= 0) throw new RangeError("The Vega stage camera scale must be greater than zero");
        camera.zoomRatio = transform.scale.x;
      }
      if (transform.rotationDegrees != null) camera.rotationX = transform.rotationDegrees;
      const stage = this.resolveTarget("stage");
      if (stage && transform.opacity != null) stage.style.opacity = String(transform.opacity);
      handle.player.SceneRoot.resize();
      if (stage) markTransformPhase(stage, phase);
      return this.transformFor(target);
    }
    const element = this.resolveTarget(target);
    if (!element) return { target, status: "missing", reason: `Stage target is not mounted: ${target}` };
    if (transform.position) element.style.translate = `${transform.position.x}px ${transform.position.y}px`;
    if (transform.scale) {
      if (transform.scale.x <= 0 || transform.scale.y <= 0) {
        throw new RangeError("Stage target scale must be greater than zero");
      }
      element.style.scale = `${transform.scale.x} ${transform.scale.y}`;
    }
    if (transform.rotationDegrees != null) element.style.rotate = `${transform.rotationDegrees}deg`;
    if (transform.opacity != null) element.style.opacity = String(transform.opacity);
    markTransformPhase(element, phase);
    return this.transformFor(target);
  }

  private resolveTarget(target: string): HTMLElement | null {
    if (!this.mount || typeof this.mount.querySelector !== "function") return null;
    if (target === "mount") return this.mount;
    if (target === "stage" || target === "camera") {
      return this.mount.querySelector<HTMLElement>("[data-vega-scene]") ?? this.mount;
    }
    if (target.startsWith("character:")) {
      const name = target.slice("character:".length);
      const characters = this.mount.querySelectorAll<HTMLElement>("[data-vega-character]");
      return [...characters].find((element) => element.dataset.vegaCharacter === name) ?? null;
    }
    const layer = target.startsWith("layer:") ? target.slice("layer:".length) : target;
    const layers = this.mount.querySelectorAll<HTMLElement>("[data-vega-layer]");
    return [...layers].find((element) => element.dataset.vegaLayer === layer) ?? null;
  }

  private stageTargets(): string[] {
    if (!this.mount || typeof this.mount.querySelectorAll !== "function") return ["stage"];
    const layers = [...this.mount.querySelectorAll<HTMLElement>("[data-vega-layer]")]
      .map((element) => element.dataset.vegaLayer)
      .filter((value): value is string => Boolean(value))
      .map((value) => `layer:${value}`);
    const characters = [...this.mount.querySelectorAll<HTMLElement>("[data-vega-character]")]
      .map((element) => element.dataset.vegaCharacter)
      .filter((value): value is string => Boolean(value))
      .map((value) => `character:${value}`);
    return ["stage", "camera", ...layers, ...characters];
  }

  private scheduleStateEvent(): void {
    if (this.stateEventQueued || this.disposed || !this.player || this.replacingRevision != null) return;
    const generation = this.stateEventGeneration;
    this.stateEventQueued = true;
    queueMicrotask(() => {
      this.stateEventQueued = false;
      if (this.disposed || !this.player || this.replacingRevision != null || generation !== this.stateEventGeneration) {
        return;
      }
      this.port.postMessage({
        protocol: VEGA_PREVIEW_PROTOCOL,
        kind: "event",
        event: "runtime.state",
        identity: this.identity,
        revision: this.latestRevision,
        snapshot: this.stageSnapshot(),
      });
    });
  }

  private emitStopped(reason: StopReason, commandIndex: number): void {
    if (this.disposed || this.replacingRevision != null) return;
    this.port.postMessage({
      protocol: VEGA_PREVIEW_PROTOCOL,
      kind: "event",
      event: "runtime.stopped",
      identity: this.identity,
      revision: this.latestRevision,
      reason,
      sceneId: this.sceneId,
      commandIndex,
    });
  }

  private emitDiagnostic(level: "info" | "warning" | "error", code: string, message: string): void {
    if (this.disposed) return;
    this.port.postMessage({
      protocol: VEGA_PREVIEW_PROTOCOL,
      kind: "event",
      event: "runtime.diagnostic",
      identity: this.identity,
      level,
      code,
      message,
    });
  }

  private replacesPlayer(request: VegaPreviewRequest): boolean {
    return (
      request.command.name === "runtime.load" ||
      request.command.name === "runtime.seek" ||
      request.command.name === "editor.sync-scene" ||
      request.command.name === "editor.run-scene" ||
      request.command.name === "editor.run-from"
    );
  }

  private matchesIdentity(identity: VegaPreviewIdentity): boolean {
    return (
      identity.workspaceId === this.identity.workspaceId &&
      identity.projectId === this.identity.projectId &&
      identity.editorSessionId === this.identity.editorSessionId &&
      identity.runtimeInstanceId === this.identity.runtimeInstanceId
    );
  }

  private requirePlayer(): VegaPlayerHandle {
    if (!this.player) throw new Error("No story is loaded in the Vega preview runtime");
    return this.player;
  }

  private reject(request: VegaPreviewRequest, code: string, message: string): void {
    this.respond(request, { status: "rejected", error: { code, message } });
  }

  private respond(request: VegaPreviewRequest, value: Pick<VegaPreviewResponse, "status" | "result" | "error">): void {
    if (this.disposed) return;
    this.port.postMessage({
      protocol: VEGA_PREVIEW_PROTOCOL,
      kind: "response",
      requestId: request.requestId,
      revision: request.revision,
      ...value,
    } satisfies VegaPreviewResponse);
  }
}

const requireSnippetCommands = (commands: readonly VegaJsonValue[]): AdvCommand[] =>
  commands.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`Preview snippet command ${index} must be an object`);
    }
    const command = (value as Record<string, unknown>).command;
    if (!Number.isSafeInteger(command) || Number(command) < 0) {
      throw new TypeError(`Preview snippet command ${index} must have a non-negative integer opcode`);
    }
    return value as unknown as AdvCommand;
  });

const cameraTransform = (camera: StoryCameraState, stage: HTMLElement | null): VegaPreviewTransform => ({
  position: { x: camera.panOffsetX, y: camera.panOffsetY },
  scale: { x: camera.zoomRatio, y: camera.zoomRatio },
  rotationDegrees: camera.rotationX,
  opacity: stage ? finiteCssNumber(stage.style.opacity, 1) : 1,
});

const elementTransform = (element: HTMLElement): VegaPreviewTransform => {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : element.style;
  const position = cssPair(style.translate, 0, 0);
  const scale = cssPair(style.scale, 1, 1);
  return {
    position: { x: position[0], y: position[1] },
    scale: { x: scale[0], y: scale[1] },
    rotationDegrees: finiteCssNumber(style.rotate, 0),
    opacity: finiteCssNumber(style.opacity, 1),
  };
};

const cssPair = (value: string, fallbackX: number, fallbackY: number): [number, number] => {
  if (!value || value === "none") return [fallbackX, fallbackY];
  const values = value.match(/-?(?:\d+\.?\d*|\.\d+)/g)?.map(Number) ?? [];
  return [
    Number.isFinite(values[0]) ? values[0] : fallbackX,
    Number.isFinite(values[1]) ? values[1] : Number.isFinite(values[0]) ? values[0] : fallbackY,
  ];
};

const finiteCssNumber = (value: string, fallback: number): number => {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
};

const markTransformPhase = (element: HTMLElement, phase: "preview" | "commit"): void => {
  if (phase === "preview") element.dataset.vegaEditorTransform = "preview";
  else element.removeAttribute("data-vega-editor-transform");
};

const snapshotState = (state: unknown): VegaJsonValue => {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(state, (_key, value: unknown) => {
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
      if (value instanceof Map) return Object.fromEntries(value);
      if (value instanceof Set) return [...value];
    }
    return value;
  });
  return serialized === undefined ? null : (JSON.parse(serialized) as VegaJsonValue);
};
