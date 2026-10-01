import type { StoryResourceLease, StoryResourceResolver } from "../rendering/StorySceneBackend";
import { storeStoryResourceFile, type StoryResourceFile } from "./StoryResourceFile";
import {
  retainOptionalStoryResourceBytes,
  type OptionalStoryResourceOptions,
  type StoryResourceBytesLease,
} from "./StoryResourceAlternatives";

export interface StoryResourceAdapter {
  readonly schemes: readonly string[];
  /** Abort must close owned I/O and reject; late values are discarded by the resolver. */
  load(url: URL, signal: AbortSignal): Promise<Uint8Array>;
}

export interface StoryResourceHttpOptions {
  /** Maximum time to wait for HTTP response headers, including connect/TLS. */
  readonly headerTimeoutMs?: number;
  /** Maximum idle time between body chunks. Progress resets this timer. */
  readonly inactivityTimeoutMs?: number;
  /** Number of additional GET attempts after a retryable network failure. */
  readonly maxRetries?: number;
}

export interface StoryResourceCacheOptions {
  /** Maximum number of hot byte arrays. Leased encoded files are independent. */
  readonly maximumEntries?: number;
  /** Maximum combined size of hot byte arrays, excluding retained files. */
  readonly maximumBytes?: number;
  /**
   * Shares fulfilled canonical bytes across sequential resolver instances.
   * Hosts use one opaque key per mounted player/resource scope.
   */
  readonly sharedKey?: object;
  /** Bounded HTTP policy for canonical fetches. Non-HTTP adapters are untouched. */
  readonly http?: StoryResourceHttpOptions;
}

interface StoryResourceCacheEntry {
  /** Resolver instance that started the underlying adapter/fetch request. */
  readonly owner: object;
  pending: Promise<Uint8Array> | undefined;
  controller: AbortController;
  bytes: Uint8Array | undefined;
  file: StoryResourceFile | undefined;
  archiving: Promise<void> | undefined;
  byteLength: number;
  waiters: number;
  retainers: number;
  settled: boolean;
}

interface StoryResourceCacheState {
  readonly entries: Map<string, StoryResourceCacheEntry>;
  readonly maximumEntries: number;
  readonly maximumBytes: number;
  byteLength: number;
}

const sharedResourceCaches = new WeakMap<object, StoryResourceCacheState>();

const DEFAULT_CACHE_MAXIMUM_ENTRIES = 256;
const DEFAULT_CACHE_MAXIMUM_BYTES = 32 * 1024 * 1024;
const DEFAULT_HTTP_HEADER_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_INACTIVITY_TIMEOUT_MS = 15_000;
const DEFAULT_HTTP_MAX_RETRIES = 1;
const MAX_HTTP_RETRIES = 3;

const normalizeScheme = (value: string): string => value.trim().toLowerCase().replace(/:$/, "");

const asUrl = (source: string): URL => {
  const base =
    typeof document !== "undefined" && document.baseURI
      ? document.baseURI
      : typeof location !== "undefined"
        ? location.href
        : "https://vega.invalid/";
  return new URL(source, base);
};

const abortError = (source: string): Error => {
  const error = new Error(`Loading was aborted: ${source}`);
  error.name = "AbortError";
  return error;
};

const cacheLimit = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
};

const timeoutLimit = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
};

const retryLimit = (value: unknown, fallback: number): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(MAX_HTTP_RETRIES, Math.floor(number)) : fallback;
};

const isHttpUrl = (url: URL): boolean => url.protocol === "http:" || url.protocol === "https:";

const isCanonicalRenderable = (url: URL): boolean => {
  const pathname = url.pathname.toLowerCase();
  return /\.(?:png|jpg|jpeg|webp|gif|svg|avif|woff2?|ttf|otf)$/u.test(pathname);
};

const httpTimeoutError = (url: URL, phase: "headers" | "body", timeoutMs: number): Error => {
  const error = new Error(`HTTP ${phase} timeout after ${timeoutMs}ms: ${url.href}`);
  error.name = "TimeoutError";
  return error;
};

const httpStatusError = (url: URL, response: Response): Error & { readonly status: number } => {
  const error = new Error(`${response.status} ${response.statusText}: ${url.href}`) as Error & {
    readonly status: number;
  };
  Object.defineProperty(error, "status", { value: response.status, enumerable: false });
  return error;
};

const isRetryableHttpError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return true;
  const status = Number((error as { status?: unknown }).status);
  if (Number.isFinite(status)) return status === 408 || status === 425 || status === 429 || status >= 500;
  return (error as Error).name !== "AbortError";
};

const waitForSharedResource = <Value>(
  pending: Promise<Value>,
  source: string,
  signal?: AbortSignal,
): Promise<Value> => {
  if (signal?.aborted) return Promise.reject(abortError(source));
  if (!signal) return pending;
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = () => finish(() => reject(abortError(source)));
    signal.addEventListener("abort", aborted, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

const waitForSharedBytes = (
  pending: Promise<Uint8Array>,
  source: string,
  signal?: AbortSignal,
  copy = true,
): Promise<Uint8Array> =>
  // SDK parsers receive an owned copy; lease-only/read-only consumers reuse
  // the canonical bytes. Storage and byte waits share cancellation semantics.
  waitForSharedResource(pending, source, signal).then((bytes) => (copy ? bytes.slice() : bytes));

export const storyResourceContentType = (source: string, bytes?: Readonly<Uint8Array>): string => {
  const embedded = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)[;,]/iu.exec(source)?.[1];
  if (embedded) return embedded.toLowerCase();
  const pathname = source.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".gif")) return "image/gif";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  if (pathname.endsWith(".avif")) return "image/avif";
  if (pathname.endsWith(".mp4")) return "video/mp4";
  if (pathname.endsWith(".webm")) return "video/webm";
  if (pathname.endsWith(".ogg") || pathname.endsWith(".opus")) return "audio/ogg";
  if (pathname.endsWith(".mp3")) return "audio/mpeg";
  if (bytes) {
    const prefix = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
    if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/iu.test(prefix)) return "image/svg+xml";
  }
  return "application/octet-stream";
};

export class DefaultStoryResourceResolver implements StoryResourceResolver {
  private readonly adapters: readonly StoryResourceAdapter[];
  private readonly cacheState: StoryResourceCacheState;
  private readonly cacheOwner = {};
  private readonly httpHeaderTimeoutMs: number;
  private readonly httpInactivityTimeoutMs: number;
  private readonly httpMaxRetries: number;

  constructor(adapters: readonly StoryResourceAdapter[] = [], cacheOptions: StoryResourceCacheOptions = {}) {
    this.adapters = [...adapters];
    const maximumEntries = cacheLimit(cacheOptions.maximumEntries, DEFAULT_CACHE_MAXIMUM_ENTRIES);
    const maximumBytes = cacheLimit(cacheOptions.maximumBytes, DEFAULT_CACHE_MAXIMUM_BYTES);
    this.httpHeaderTimeoutMs = timeoutLimit(cacheOptions.http?.headerTimeoutMs, DEFAULT_HTTP_HEADER_TIMEOUT_MS);
    this.httpInactivityTimeoutMs = timeoutLimit(
      cacheOptions.http?.inactivityTimeoutMs,
      DEFAULT_HTTP_INACTIVITY_TIMEOUT_MS,
    );
    this.httpMaxRetries = retryLimit(cacheOptions.http?.maxRetries, DEFAULT_HTTP_MAX_RETRIES);
    const sharedKey = cacheOptions.sharedKey;
    let cacheState = sharedKey ? sharedResourceCaches.get(sharedKey) : undefined;
    if (!cacheState) {
      cacheState = {
        entries: new Map(),
        maximumEntries,
        maximumBytes,
        byteLength: 0,
      };
      if (sharedKey) sharedResourceCaches.set(sharedKey, cacheState);
    } else if (
      (cacheOptions.maximumEntries !== undefined && cacheState.maximumEntries !== maximumEntries) ||
      (cacheOptions.maximumBytes !== undefined && cacheState.maximumBytes !== maximumBytes)
    ) {
      throw new TypeError("Story resource resolvers sharing a cache key must use identical cache limits");
    }
    this.cacheState = cacheState;
  }

  private get cache(): Map<string, StoryResourceCacheEntry> {
    return this.cacheState.entries;
  }

  private get cachedByteLength(): number {
    return this.cacheState.byteLength;
  }

  private set cachedByteLength(value: number) {
    this.cacheState.byteLength = value;
  }

  private get maximumCacheEntries(): number {
    return this.cacheState.maximumEntries;
  }

  private get maximumCacheBytes(): number {
    return this.cacheState.maximumBytes;
  }

  canLoad(source: string): boolean {
    if (!source) return false;
    const url = asUrl(source);
    if (this.adapterFor(url)) return true;
    return ["http:", "https:", "data:", "blob:", "file:"].includes(url.protocol);
  }

  async load(source: string, signal?: AbortSignal): Promise<Uint8Array> {
    return (await this.acquireBytes(source, signal, true)) as Uint8Array;
  }

  /**
   * Trusted read-only path used by renderer integrations. `load` deliberately
   * remains copy-on-read so ordinary plugin and SDK consumers keep isolation.
   */
  async loadSharedBytes(source: string, signal?: AbortSignal): Promise<Readonly<Uint8Array>> {
    return this.acquireBytes(source, signal, false);
  }

  /** Optional provider facade; format/capability selection stays with its caller. */
  retainOptionalBytes(source: string, options: OptionalStoryResourceOptions): Promise<StoryResourceBytesLease> {
    return retainOptionalStoryResourceBytes(this, source, options);
  }

  private async acquireBytes(source: string, signal: AbortSignal | undefined, copy: boolean): Promise<Uint8Array> {
    if (signal?.aborted) throw abortError(source);
    if (!this.canLoad(source)) {
      throw new TypeError(`No resource adapter can load: ${source}`);
    }
    const url = asUrl(source);
    const key = url.href;
    let entry = this.cache.get(key);
    // Only fulfilled canonical bytes cross resolver lifetimes. A pending entry
    // is tied to the adapter and lifetime of the resolver that started it, so a
    // replacement resolver must start its own request instead of inheriting a
    // request that may be aborted during old-plugin disposal.
    if (entry && !entry.file && !entry.settled && entry.owner !== this.cacheOwner) {
      entry = undefined;
    }
    if (entry) {
      this.touchCacheEntry(key, entry);
    } else {
      entry = this.createCacheEntry(key, url);
      this.cache.set(key, entry);
      this.trimCache();
    }
    entry.waiters += 1;
    try {
      return await waitForSharedBytes(this.pendingBytes(key, entry, url), source, signal, copy);
    } finally {
      entry.waiters = Math.max(0, entry.waiters - 1);
      // Caller abort is isolated while another model still needs these bytes.
      // Once every waiter has gone away, however, continuing a multi-megabyte
      // MOC/texture request would only waste bandwidth and cache space.
      if (!entry.settled && entry.waiters === 0 && entry.retainers === 0) {
        // Remove the doomed single-flight before aborting it. Otherwise a new
        // caller can briefly attach to the already-aborting request and fail
        // even though it did not participate in the cancellation.
        this.deleteCacheEntry(key, entry);
        entry.controller.abort();
      }
      this.trimCache();
    }
  }

  async retain(source: string, signal?: AbortSignal): Promise<StoryResourceLease> {
    if (signal?.aborted) throw abortError(source);
    if (!this.canLoad(source)) {
      throw new TypeError(`No resource adapter can load: ${source}`);
    }
    const url = asUrl(source);
    const key = url.href;
    let entry = this.cache.get(key);
    if (entry && !entry.file && !entry.settled && entry.owner !== this.cacheOwner) {
      entry = undefined;
    }
    if (entry) {
      this.touchCacheEntry(key, entry);
    } else {
      entry = this.createCacheEntry(key, url);
      this.cache.set(key, entry);
      this.trimCache();
    }
    entry.retainers += 1;
    let retained = true;
    const release = (): void => {
      if (!retained) return;
      retained = false;
      entry!.retainers = Math.max(0, entry!.retainers - 1);
      if (!entry!.settled && entry!.waiters === 0 && entry!.retainers === 0) {
        this.deleteCacheEntry(key, entry!);
        entry!.controller.abort();
      } else {
        if (entry!.retainers === 0) {
          entry!.file?.release();
          entry!.file = undefined;
          if (!entry!.bytes && !entry!.pending) this.deleteCacheEntry(key, entry!);
        }
        this.trimCache();
      }
    };
    try {
      if (!entry.file) {
        const bytes = await waitForSharedBytes(this.pendingBytes(key, entry, url), source, signal, false);
        await waitForSharedResource(this.archiveEntry(entry, bytes, key), source, signal);
      }
      if (signal?.aborted) throw abortError(source);
      this.trimCache();
    } catch (error) {
      release();
      throw error;
    }
    return Object.freeze({ release });
  }

  async resolveRenderable(
    source: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url: string; readonly release: () => void }> {
    const url = asUrl(source);
    // Reuse already prepared bytes for every resource, including audio and
    // video. Unprepared streaming/opaque browser URLs remain direct. Known
    // HTTP images and fonts use the bounded canonical loader on cache misses.
    if (!this.adapterFor(url) && !this.cache.has(url.href) && !(isHttpUrl(url) && isCanonicalRenderable(url))) {
      return { url: source, release: () => undefined };
    }
    if (signal?.aborted) throw abortError(source);
    const entry = this.cache.get(url.href);
    let blob = entry?.file
      ? await waitForSharedResource(
          entry.file.read().catch(() => undefined),
          source,
          signal,
        )
      : undefined;
    if (signal?.aborted) throw abortError(source);
    if (!blob) {
      const bytes = await this.loadSharedBytes(source, signal);
      blob = new Blob([bytes.buffer as ArrayBuffer], { type: storyResourceContentType(source, bytes) });
    }
    const objectUrl = URL.createObjectURL(blob);
    let released = false;
    return {
      url: objectUrl,
      release: () => {
        if (released) return;
        released = true;
        URL.revokeObjectURL(objectUrl);
      },
    };
  }

  private adapterFor(url: URL): StoryResourceAdapter | undefined {
    const scheme = normalizeScheme(url.protocol);
    return this.adapters.find((adapter) => adapter.schemes.some((candidate) => normalizeScheme(candidate) === scheme));
  }

  private createCacheEntry(key: string, url: URL): StoryResourceCacheEntry {
    const entry: StoryResourceCacheEntry = {
      owner: this.cacheOwner,
      pending: undefined,
      controller: new AbortController(),
      bytes: undefined,
      file: undefined,
      archiving: undefined,
      byteLength: 0,
      waiters: 0,
      retainers: 0,
      settled: false,
    };
    this.pendingBytes(key, entry, url);
    return entry;
  }

  private archiveEntry(entry: StoryResourceCacheEntry, bytes: Uint8Array, source: string): Promise<void> {
    if (entry.file) return Promise.resolve();
    entry.archiving ??= storeStoryResourceFile(
      new Blob([bytes.buffer as ArrayBuffer], { type: storyResourceContentType(source, bytes) }),
    )
      .then((file) => {
        if (entry.retainers > 0) entry.file = file;
        else file.release();
      })
      .finally(() => {
        entry.archiving = undefined;
      });
    return entry.archiving;
  }

  private pendingBytes(key: string, entry: StoryResourceCacheEntry, url: URL): Promise<Uint8Array> {
    if (entry.bytes) return Promise.resolve(entry.bytes);
    if (entry.pending) return entry.pending;
    entry.controller = new AbortController();
    entry.settled = false;
    const load = async (): Promise<Uint8Array> => {
      const blob = await entry.file?.read().catch(() => undefined);
      if (entry.controller.signal.aborted) throw abortError(key);
      if (blob) return new Uint8Array(await blob.arrayBuffer());
      // Browser storage can be cleared externally. Recover through the same
      // bounded request path, never through an untracked media-element fetch.
      entry.file?.release();
      entry.file = undefined;
      return this.loadCanonical(url, entry.controller.signal);
    };
    const pending = load()
      .then(
        async (value) => {
          entry.settled = true;
          if (entry.controller.signal.aborted) throw abortError(key);
          // HTTP and disk readers already return owned buffers. Adapter input
          // may be reused or mutated by its host, so isolate only that path.
          const bytes = this.adapterFor(url) ? Uint8Array.from(value) : value;
          if (this.cache.get(key) !== entry) return bytes;
          // An individually oversized resource must not flush every useful entry
          // before being evicted itself. An active lease still takes precedence;
          // once released, the normal trim pass removes the oversized entry.
          if (entry.retainers === 0 && (this.maximumCacheEntries === 0 || bytes.byteLength > this.maximumCacheBytes)) {
            this.cache.delete(key);
            return bytes;
          }
          entry.bytes = bytes;
          entry.byteLength = bytes.byteLength;
          this.cachedByteLength += bytes.byteLength;
          this.touchCacheEntry(key, entry);
          if (entry.retainers > 0) await this.archiveEntry(entry, bytes, key);
          this.trimCache();
          return bytes;
        },
        (error: unknown) => {
          entry.settled = true;
          if (this.cache.get(key) === entry) this.deleteCacheEntry(key, entry);
          throw error;
        },
      )
      .finally(() => {
        // A fulfilled Promise would itself keep the entire byte buffer alive
        // after the memory LRU releases it. Only in-flight work is retained here.
        if (entry.pending === pending) entry.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }

  private async loadCanonical(url: URL, signal: AbortSignal): Promise<Uint8Array> {
    const adapter = this.adapterFor(url);
    if (adapter) return adapter.load(url, signal);
    if (!isHttpUrl(url)) {
      const response = await fetch(url.href, { signal });
      if (!response.ok) throw httpStatusError(url, response);
      return new Uint8Array(await response.arrayBuffer());
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.httpMaxRetries; attempt += 1) {
      if (signal.aborted) throw abortError(url.href);
      try {
        return await this.loadHttpAttempt(url, signal);
      } catch (error) {
        if (signal.aborted) throw abortError(url.href);
        lastError = error;
        if (attempt >= this.httpMaxRetries || !isRetryableHttpError(error)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Unable to load ${url.href}`);
  }

  private async loadHttpAttempt(url: URL, signal: AbortSignal): Promise<Uint8Array> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(signal.reason);
    let headerTimedOut = false;
    const headerTimer = setTimeout(() => {
      headerTimedOut = true;
      controller.abort();
    }, this.httpHeaderTimeoutMs);
    signal.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await fetch(url.href, { method: "GET", signal: controller.signal });
      clearTimeout(headerTimer);
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw httpStatusError(url, response);
      }
      return await this.readHttpBody(url, response, controller);
    } catch (error) {
      if (signal.aborted) throw abortError(url.href);
      if (controller.signal.aborted && headerTimedOut) {
        throw httpTimeoutError(url, "headers", this.httpHeaderTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(headerTimer);
      signal.removeEventListener("abort", forwardAbort);
    }
  }

  private async readHttpBody(url: URL, response: Response, controller: AbortController): Promise<Uint8Array> {
    if (!response.body) {
      return new Uint8Array(await this.withHttpInactivityTimeout(url, response.arrayBuffer(), controller));
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      while (true) {
        const result = await this.withHttpInactivityTimeout(url, reader.read(), controller);
        if (result.done) break;
        if (!result.value?.byteLength) continue;
        chunks.push(result.value);
        byteLength += result.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private withHttpInactivityTimeout<T>(url: URL, pending: Promise<T>, controller: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(httpTimeoutError(url, "body", this.httpInactivityTimeoutMs));
      }, this.httpInactivityTimeoutMs);
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private touchCacheEntry(key: string, entry: StoryResourceCacheEntry): void {
    if (this.cache.get(key) !== entry) return;
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private deleteCacheEntry(key: string, entry: StoryResourceCacheEntry): void {
    if (this.cache.get(key) !== entry) return;
    this.cache.delete(key);
    this.cachedByteLength = Math.max(0, this.cachedByteLength - entry.byteLength);
    entry.bytes = undefined;
    entry.byteLength = 0;
    if (entry.retainers === 0) {
      entry.file?.release();
      entry.file = undefined;
    }
  }

  private trimCache(): void {
    let memoryEntries = [...this.cache.values()].filter((entry) => entry.bytes).length;
    while (memoryEntries > this.maximumCacheEntries || this.cachedByteLength > this.maximumCacheBytes) {
      let removed = false;
      for (const [key, entry] of this.cache) {
        // Keep in-flight work addressable so every concurrent waiter shares one
        // underlying adapter/fetch request. Temporary entry-count overflow is
        // trimmed as requests settle.
        if (!entry.bytes || entry.waiters > 0 || (entry.retainers > 0 && !entry.file)) continue;
        if (entry.retainers > 0) {
          this.cachedByteLength = Math.max(0, this.cachedByteLength - entry.byteLength);
          entry.bytes = undefined;
          entry.byteLength = 0;
        } else this.deleteCacheEntry(key, entry);
        memoryEntries -= 1;
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }
}
