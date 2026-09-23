import type { StoryResourceLease, StoryResourceResolver } from "../rendering/StorySceneBackend";

export interface StoryResourceAdapter {
  readonly schemes: readonly string[];
  load(url: URL, signal: AbortSignal): Promise<Uint8Array>;
}

export interface StoryResourceCacheOptions {
  /** Maximum number of fulfilled resources retained by the resolver. */
  readonly maximumEntries?: number;
  /** Maximum combined byte length of fulfilled resources retained by the resolver. */
  readonly maximumBytes?: number;
  /**
   * Shares fulfilled canonical bytes across sequential resolver instances.
   * Hosts use one opaque key per mounted player/resource scope.
   */
  readonly sharedKey?: object;
}

interface StoryResourceCacheEntry {
  /** Resolver instance that started the underlying adapter/fetch request. */
  readonly owner: object;
  readonly pending: Promise<Uint8Array>;
  readonly controller: AbortController;
  bytes: Uint8Array | undefined;
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
const DEFAULT_CACHE_MAXIMUM_BYTES = 128 * 1024 * 1024;

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

const waitForSharedBytes = (
  pending: Promise<Uint8Array>,
  source: string,
  signal?: AbortSignal,
  copy = true,
): Promise<Uint8Array> => {
  if (signal?.aborted) return Promise.reject(abortError(source));
  // The retained byte array is private immutable cache state. Every caller gets
  // an owned copy so an SDK parser that writes into its input cannot corrupt a
  // later model constructed from the same preloaded resource. A lease-only
  // waiter does not consume the value and can skip that otherwise wasted copy.
  if (!signal) return pending.then((bytes) => (copy ? bytes.slice() : bytes));
  return new Promise<Uint8Array>((resolve, reject) => {
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
      (bytes) => finish(() => resolve(copy ? bytes.slice() : bytes)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
};

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

  constructor(adapters: readonly StoryResourceAdapter[] = [], cacheOptions: StoryResourceCacheOptions = {}) {
    this.adapters = [...adapters];
    const maximumEntries = cacheLimit(cacheOptions.maximumEntries, DEFAULT_CACHE_MAXIMUM_ENTRIES);
    const maximumBytes = cacheLimit(cacheOptions.maximumBytes, DEFAULT_CACHE_MAXIMUM_BYTES);
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
    if (entry && !entry.settled && entry.owner !== this.cacheOwner) {
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
      return await waitForSharedBytes(entry.pending, source, signal, copy);
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
    if (entry && !entry.settled && entry.owner !== this.cacheOwner) {
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
        this.trimCache();
      }
    };
    try {
      await waitForSharedBytes(entry.pending, source, signal, false);
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
    // Plain browser URLs normally remain direct. Once canonical bytes have
    // been preloaded or retained, however, materialize from that same entry so
    // an <img>, media element, or third-party runtime cannot request the URL a
    // second time behind the resolver's back.
    if (!this.adapterFor(url) && !this.cache.has(url.href)) {
      return { url: source, release: () => undefined };
    }
    const bytes = await this.loadSharedBytes(source, signal);
    // Canonical cache entries are normalized to a full ArrayBuffer-backed
    // Uint8Array. Passing that buffer directly avoids two JavaScript copies;
    // Blob owns the resulting immutable payload.
    const objectUrl = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: storyResourceContentType(source, bytes) }),
    );
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
    const controller = new AbortController();
    let entry!: StoryResourceCacheEntry;
    const pending = this.loadCanonical(url, controller.signal).then(
      (value) => {
        entry.settled = true;
        const bytes = Uint8Array.from(value);
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
        this.trimCache();
        return bytes;
      },
      (error: unknown) => {
        entry.settled = true;
        if (this.cache.get(key) === entry) this.deleteCacheEntry(key, entry);
        throw error;
      },
    );
    entry = {
      owner: this.cacheOwner,
      pending,
      controller,
      bytes: undefined,
      byteLength: 0,
      waiters: 0,
      retainers: 0,
      settled: false,
    };
    return entry;
  }

  private async loadCanonical(url: URL, signal: AbortSignal): Promise<Uint8Array> {
    const adapter = this.adapterFor(url);
    if (adapter) return adapter.load(url, signal);
    const response = await fetch(url.href, { signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${url.href}`);
    }
    return new Uint8Array(await response.arrayBuffer());
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
  }

  private trimCache(): void {
    while (this.cache.size > this.maximumCacheEntries || this.cachedByteLength > this.maximumCacheBytes) {
      let removed = false;
      for (const [key, entry] of this.cache) {
        // Keep in-flight work addressable so every concurrent waiter shares one
        // underlying adapter/fetch request. Temporary entry-count overflow is
        // trimmed as requests settle.
        if (!entry.bytes || entry.retainers > 0) continue;
        this.deleteCacheEntry(key, entry);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }
}
