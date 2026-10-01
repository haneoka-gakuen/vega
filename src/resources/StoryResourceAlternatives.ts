import type { StoryResourceLease, StoryResourceResolver } from "../rendering/StorySceneBackend";

export interface StoryResourceBytesLease extends StoryResourceLease {
  readonly source: string;
  /** Trusted immutable input. SDKs that mutate buffers must copy this view. */
  readonly bytes: Readonly<Uint8Array>;
}

export interface OptionalStoryResourceOptions {
  /** Cancels acquisition; a successful result belongs to its explicit release owner. */
  readonly signal?: AbortSignal;
  /** Absolute performance.now() deadline, shared by all optional candidates. */
  readonly expiresAt: number;
}

const preparationError = (name: "AbortError" | "TimeoutError", source: string): Error => {
  const error = new Error(
    `Optional story resource ${name === "TimeoutError" ? "deadline expired" : "aborted"}: ${source}`,
  );
  error.name = name;
  return error;
};

const waitForOptionalResource = <Value>(
  pending: Promise<Value>,
  signal: AbortSignal,
  discard?: (value: Value) => void,
): Promise<Value> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      action();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => {
        if (!settled) finish(() => resolve(value));
        else if (discard) {
          try {
            discard(value);
          } catch (error) {
            console.error("[Vega] late optional resource release failed", error);
          }
        }
      },
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) aborted();
  });

/**
 * Prepare encoded bytes for one provider-selected optional resource. Selection,
 * format validation, decoding and GPU allocation remain with the provider.
 * Release the returned lease on upload completion or with its resource owner.
 * Downstream optional decoding must keep the same expiresAt budget.
 */
export const retainOptionalStoryResourceBytes = async (
  resources: StoryResourceResolver,
  source: string,
  options: OptionalStoryResourceOptions,
): Promise<StoryResourceBytesLease> => {
  if (!Number.isFinite(options.expiresAt)) throw new TypeError("An optional resource requires a finite deadline");
  const controller = new AbortController();
  const expired = (): Error => preparationError("TimeoutError", source);
  const abort = (): void => controller.abort(options.signal?.reason ?? preparationError("AbortError", source));
  const check = (): void => {
    if (!controller.signal.aborted && performance.now() >= options.expiresAt) controller.abort(expired());
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(expired()), Math.max(0, options.expiresAt - performance.now()));
  let lease: StoryResourceLease | undefined;
  try {
    check();
    lease = await waitForOptionalResource(resources.retain(source, controller.signal), controller.signal, (late) =>
      late.release(),
    );
    check();
    let bytes: Readonly<Uint8Array> | undefined = await waitForOptionalResource(
      resources.loadSharedBytes
        ? resources.loadSharedBytes(source, controller.signal)
        : resources.load(source, controller.signal),
      controller.signal,
    );
    check();
    const owned = lease;
    return Object.freeze({
      source,
      get bytes() {
        if (!bytes) throw new ReferenceError(`Optional story resource was released: ${source}`);
        return bytes;
      },
      release() {
        if (!bytes) return;
        bytes = undefined;
        owned.release();
      },
    });
  } catch (error) {
    const failure = controller.signal.aborted ? controller.signal.reason : error;
    try {
      lease?.release();
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], "Optional resource preparation and release failed");
    }
    throw failure;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
};
