import {
  createVega,
  type AdvPlayerState,
  type AdvStory,
  type VegaEngine,
  type VegaEngineOptions,
  type VegaPlayerHandle,
  type VegaPlayerOptions,
  type VegaPlayerShellOptions,
  vegaProjectToAdvStory,
} from "@haneoka/vega/engine";
import type { VegaProject } from "@haneoka/vega-protocol";
import {
  forwardRef,
  type CSSProperties,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

export type VegaPlayerAppearance = "light" | "system" | "dark";

export interface VegaPlayerController {
  /** The current low-level handle, or `null` while mounting/disposed. */
  readonly handle: VegaPlayerHandle | null;
  /** The last adapter, engine, or playback error. */
  readonly error: unknown | null;
  /** Resolves for the current source after its player is mounted. */
  ready(): Promise<VegaPlayerHandle>;
  /** Starts the selected entry scene. Safe to call more than once. */
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  dispose(): Promise<void>;
}

interface VegaPlayerSharedProps {
  readonly engine?: VegaEngine;
  /** Used only when the adapter owns the engine. */
  readonly engineOptions?: VegaEngineOptions;
  /** Forwarded to `VegaEngine.createPlayer`. Adapter-owned fields are omitted. */
  readonly playerOptions?: Omit<
    VegaPlayerOptions,
    "mount" | "shell" | "story" | "theme"
  >;
  readonly shell?: false | VegaPlayerShellOptions;
  /** Vega theme contribution id. `false` leaves the engine presentation unthemed. */
  readonly theme?: string | false;
  /** Host color scheme. It does not select a Vega theme contribution. */
  readonly appearance?: VegaPlayerAppearance;
  /** Start the entry scene after mounting. */
  readonly autoStart?: boolean;
  /** Enable ADV automatic progression after mounting. */
  readonly autoPlay?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly onReady?: (
    handle: VegaPlayerHandle,
    controller: VegaPlayerController,
  ) => void;
  readonly onError?: (error: unknown) => void;
}

export type VegaPlayerProps = VegaPlayerSharedProps &
  (
    | {
        readonly story: AdvStory;
        readonly project?: never;
        readonly sceneId?: never;
      }
    | {
        readonly project: VegaProject;
        readonly story?: never;
        /** Starts from this scene instead of `project.entryScene`. */
        readonly sceneId?: string;
      }
  );

interface ReadyDeferred {
  readonly promise: Promise<VegaPlayerHandle>;
  readonly resolve: (handle: VegaPlayerHandle) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

interface ActiveSession {
  readonly engine: VegaEngine;
  readonly ownsEngine: boolean;
  readonly entryKey?: string;
  readonly ready: ReadyDeferred;
  handle: VegaPlayerHandle | null;
  started: boolean;
  disposed: boolean;
  disposal: Promise<void> | null;
  playback: Promise<void> | null;
  error: unknown | null;
}

const shellStyle: CSSProperties = {
  minHeight: 420,
  overflow: "hidden",
  position: "relative",
};

const stageStyle: CSSProperties = { inset: 0, position: "absolute" };

const uiSignature = (state: AdvPlayerState): string =>
  JSON.stringify([state.loading, state.error]);

const createReadyDeferred = (): ReadyDeferred => {
  let resolvePromise!: (handle: VegaPlayerHandle) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<VegaPlayerHandle>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A source can be replaced before consumers call `ready()`. Keep that
  // cancellation observable without creating an unhandled rejection.
  void promise.catch(() => undefined);
  const deferred: ReadyDeferred = {
    promise,
    settled: false,
    resolve(handle) {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(handle);
    },
    reject(error) {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
  };
  return deferred;
};

const sourceBinding = (
  story: AdvStory | undefined,
  project: VegaProject | undefined,
  sceneId: string | undefined,
): { readonly story: AdvStory; readonly entryKey?: string } => {
  if (project) {
    const compiled = vegaProjectToAdvStory(project, sceneId);
    const entryKey =
      typeof compiled.vegaEntryKey === "string"
        ? compiled.vegaEntryKey
        : undefined;
    return { story: compiled, ...(entryKey ? { entryKey } : {}) };
  }
  if (story) return { story };
  throw new TypeError("VegaPlayer requires either story or project");
};

const appearanceColorScheme = (
  appearance: VegaPlayerAppearance,
): CSSProperties["colorScheme"] =>
  appearance === "system" ? "light dark" : appearance;

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const disposeSession = (session: ActiveSession): Promise<void> => {
  if (session.disposal) return session.disposal;
  session.disposed = true;
  session.ready.reject(
    abortError("Vega player was disposed before becoming ready"),
  );
  session.disposal = (async () => {
    const results = await Promise.allSettled([
      session.handle?.dispose(),
      session.ownsEngine ? session.engine.dispose() : undefined,
    ]);
    session.handle = null;
    const errors = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map(({ reason }) => reason);
    if (errors.length)
      throw new AggregateError(
        errors,
        "Failed to dispose Vega React resources",
      );
  })();
  return session.disposal;
};

const trackPlayback = (
  session: ActiveSession,
  operation: Promise<void>,
  reportError: (error: unknown) => void,
): void => {
  session.playback = operation;
  void operation.catch((error: unknown) => {
    if (!session.disposed) {
      session.error = error;
      reportError(error);
    }
  });
};

const startSession = async (
  session: ActiveSession,
  reportError: (error: unknown) => void,
): Promise<void> => {
  const handle = session.handle ?? (await session.ready.promise);
  if (session.disposed)
    throw new ReferenceError("The Vega React player is disposed");
  if (!session.started) {
    if (session.entryKey) handle.player.navigateToKey(session.entryKey);
    session.started = true;
  }
  if (handle.shell) {
    handle.shell.resume();
    return;
  }
  handle.player.resume();
  if (!handle.player.state.playing)
    trackPlayback(session, handle.player.play(), reportError);
};

export const VegaPlayer = forwardRef<VegaPlayerController, VegaPlayerProps>(
  function VegaPlayer(
    {
      story,
      project,
      sceneId,
      engine: providedEngine,
      engineOptions,
      playerOptions,
      shell,
      theme,
      appearance = "system",
      autoStart = true,
      autoPlay = false,
      className,
      style,
      onReady,
      onError,
    },
    forwardedRef,
  ) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sessionRef = useRef<ActiveSession | null>(null);
    const callbacksRef = useRef({ onError, onReady });
    callbacksRef.current = { onError, onReady };
    const [status, setStatus] = useState({ loading: false, error: "" });
    const errorRef = useRef<unknown | null>(null);

    const reportError = (error: unknown) => {
      errorRef.current = error;
      callbacksRef.current.onError?.(error);
      setStatus((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    };

    useImperativeHandle(
      forwardedRef,
      (): VegaPlayerController => ({
        get handle() {
          return sessionRef.current?.handle ?? null;
        },
        get error() {
          return errorRef.current;
        },
        ready() {
          const session = sessionRef.current;
          return session
            ? session.ready.promise
            : Promise.reject(
                new ReferenceError("The Vega React player is not mounted"),
              );
        },
        start() {
          const session = sessionRef.current;
          return session
            ? startSession(session, reportError)
            : Promise.reject(
                new ReferenceError("The Vega React player is not mounted"),
              );
        },
        pause() {
          const handle = sessionRef.current?.handle;
          if (handle?.shell) handle.shell.pause();
          else handle?.player.pause();
        },
        async resume() {
          const session = sessionRef.current;
          if (!session)
            throw new ReferenceError("The Vega React player is not mounted");
          await startSession(session, reportError);
        },
        dispose() {
          const session = sessionRef.current;
          return session ? disposeSession(session) : Promise.resolve();
        },
      }),
      [],
    );

    useEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;
      let binding: ReturnType<typeof sourceBinding>;
      try {
        binding = sourceBinding(story, project, sceneId);
      } catch (error) {
        reportError(error);
        return;
      }
      const engine =
        providedEngine ??
        createVega(engineOptions);
      const session: ActiveSession = {
        engine,
        ownsEngine: !providedEngine,
        ready: createReadyDeferred(),
        handle: null,
        started: false,
        disposed: false,
        disposal: null,
        playback: null,
        error: null,
        ...(binding.entryKey ? { entryKey: binding.entryKey } : {}),
      };
      sessionRef.current = session;
      errorRef.current = null;
      setStatus({ loading: false, error: "" });
      let frame = 0;
      let lastSignature = "";
      let lastStateError = "";

      const updatePresentation = (playerState: AdvPlayerState) => {
        if (session.disposed || sessionRef.current !== session) return;
        const signature = uiSignature(playerState);
        if (signature !== lastSignature) {
          lastSignature = signature;
          setStatus({
            loading: playerState.loading,
            error: playerState.error,
          });
        }
        if (playerState.error && playerState.error !== lastStateError) {
          lastStateError = playerState.error;
          session.error = new Error(playerState.error);
          reportError(session.error);
        }
        frame = requestAnimationFrame(() => updatePresentation(playerState));
      };

      void engine
        .createPlayer({
          ...playerOptions,
          mount,
          story: binding.story,
          ...(shell !== undefined ? { shell } : {}),
          ...(theme !== undefined ? { theme } : {}),
        })
        .then(async (handle) => {
          if (session.disposed || sessionRef.current !== session) {
            await handle.dispose();
            return;
          }
          session.handle = handle;
          if (binding.entryKey) handle.player.navigateToKey(binding.entryKey);
          setStatus({
            loading: handle.player.state.loading,
            error: handle.player.state.error,
          });
          session.ready.resolve(handle);
          frame = requestAnimationFrame(() =>
            updatePresentation(handle.player.state),
          );
          try {
            callbacksRef.current.onReady?.(
              handle,
              controllerForSession(session, reportError),
            );
          } catch (error) {
            reportError(error);
          }
        })
        .catch((error: unknown) => {
          session.error = error;
          session.ready.reject(error);
          if (!session.disposed) reportError(error);
        });

      return () => {
        cancelAnimationFrame(frame);
        setStatus({ loading: false, error: "" });
        if (sessionRef.current === session) sessionRef.current = null;
        void disposeSession(session).catch((error: unknown) =>
          callbacksRef.current.onError?.(error),
        );
      };
    }, [
      engineOptions,
      playerOptions,
      project,
      providedEngine,
      sceneId,
      shell,
      story,
      theme,
    ]);

    useEffect(() => {
      const handle = sessionRef.current?.handle;
      if (handle && handle.player.state.autoPlay !== autoPlay)
        handle.player.toggleAuto();
    }, [autoPlay, status]);

    useEffect(() => {
      const session = sessionRef.current;
      if (!autoStart || !session?.handle || session.started) return;
      void startSession(session, reportError).catch(reportError);
    }, [autoStart, status]);

    return (
      <section
        aria-busy={status.loading || undefined}
        aria-label="Vega visual novel player"
        className={className}
        data-vega-appearance={appearance}
        style={{
          ...shellStyle,
          colorScheme: appearanceColorScheme(appearance),
          ...style,
        }}
      >
        <div ref={mountRef} style={stageStyle} />
        {status.error ? (
          <div
            role="alert"
            style={{
              background: "color-mix(in srgb, Canvas 84%, #b3261e 16%)",
              color: "CanvasText",
              inset: "12px 12px auto",
              padding: 12,
              position: "absolute",
            }}
          >
            {status.error}
          </div>
        ) : null}
      </section>
    );
  },
);

const controllerForSession = (
  session: ActiveSession,
  reportError: (error: unknown) => void,
): VegaPlayerController => ({
  get handle() {
    return session.handle;
  },
  get error() {
    const message = session.handle?.player.state.error;
    return session.error ?? (message ? new Error(message) : null);
  },
  ready: () => session.ready.promise,
  start: () => startSession(session, reportError),
  pause() {
    const handle = session.handle;
    if (handle?.shell) handle.shell.pause();
    else handle?.player.pause();
  },
  resume: () => startSession(session, reportError),
  dispose: () => disposeSession(session),
});
