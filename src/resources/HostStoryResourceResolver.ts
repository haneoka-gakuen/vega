import type { StoryResourceLease, StoryResourceResolver } from "./StoryResourcePort.js";

const disposedError = (): Error => {
  const error = new Error("Vega host resource scope is disposed");
  error.name = "AbortError";
  return error;
};

/**
 * One player-owned scope over explicit host I/O. URI handling, caching and
 * storage stay with the host; this scope owns requests and acquired leases.
 */
export class HostStoryResourceResolver implements StoryResourceResolver {
  private readonly requests = new Set<AbortController>();
  private readonly releases = new Set<() => void>();
  private disposed = false;

  constructor(private readonly host: StoryResourceResolver) {}

  canLoad(source: string): boolean {
    return !this.disposed && this.host.canLoad(source) && !this.disposed;
  }

  async load(source: string, signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = await this.run(source, signal, (request) => this.host.load(source, request));
    return Uint8Array.from(bytes);
  }

  async loadSharedBytes(source: string, signal?: AbortSignal): Promise<Readonly<Uint8Array>> {
    return this.run(source, signal, (request) =>
      this.host.loadSharedBytes ? this.host.loadSharedBytes(source, request) : this.host.load(source, request),
    );
  }

  async retain(source: string, signal?: AbortSignal): Promise<StoryResourceLease> {
    const lease = await this.run(
      source,
      signal,
      (request) => this.host.retain(source, request),
      (late) => late.release(),
    );
    return Object.freeze({ release: this.trackRelease(() => lease.release(), signal) });
  }

  async resolveRenderable(
    source: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url: string; readonly release: () => void }> {
    const lease = await this.run(
      source,
      signal,
      (request) => this.host.resolveRenderable(source, request),
      (late) => late.release(),
    );
    return Object.freeze({ url: lease.url, release: this.trackRelease(() => lease.release(), signal) });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of [...this.requests]) request.abort(disposedError());
    const errors: unknown[] = [];
    for (const release of [...this.releases]) {
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Vega host resource release failed");
  }

  private trackRelease(releaseHost: () => void, signal?: AbortSignal): () => void {
    if (this.disposed || signal?.aborted) {
      const reason = signal?.aborted ? signal.reason : disposedError();
      try {
        releaseHost();
      } catch (error) {
        throw new AggregateError([reason, error], "Vega resource acquisition and release failed");
      }
      throw reason;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releases.delete(release);
      releaseHost();
    };
    this.releases.add(release);
    return release;
  }

  private run<Value>(
    source: string,
    signal: AbortSignal | undefined,
    read: (signal: AbortSignal) => Promise<Value>,
    discard?: (value: Value) => void,
  ): Promise<Value> {
    if (this.disposed) return Promise.reject(disposedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.host.canLoad(source)) return Promise.reject(new TypeError(`Host cannot load resource: ${source}`));
    if (this.disposed) return Promise.reject(disposedError());
    const controller = new AbortController();
    this.requests.add(controller);
    return new Promise<Value>((resolve, reject) => {
      let settled = false;
      const forwardAbort = (): void => controller.abort(signal?.reason);
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        this.requests.delete(controller);
        controller.signal.removeEventListener("abort", aborted);
        signal?.removeEventListener("abort", forwardAbort);
        action();
      };
      const aborted = (): void => finish(() => reject(controller.signal.reason));
      controller.signal.addEventListener("abort", aborted, { once: true });
      signal?.addEventListener("abort", forwardAbort, { once: true });
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return read(controller.signal);
        })
        .then(
          (value) => {
            if (!settled) finish(() => resolve(value));
            else if (discard) {
              try {
                discard(value);
              } catch (error) {
                console.error("[Vega] late host resource release failed", error);
              }
            }
          },
          (error: unknown) => finish(() => reject(error)),
        );
      if (signal?.aborted) forwardAbort();
    });
  }
}
