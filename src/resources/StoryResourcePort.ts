/** Encoded resource ownership, independent from decoded media and GPU objects. */
export interface StoryResourceLease {
  release(): void;
}

/** Host I/O contract shared by native ADV loading and renderer adapters. */
export interface StoryResourceResolver {
  canLoad(source: string): boolean;
  /** Returns an owned byte array suitable for a parser or SDK. */
  load(source: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** Trusted immutable resident bytes; callers must not mutate this view. */
  loadSharedBytes?(source: string, signal?: AbortSignal): Promise<Readonly<Uint8Array>>;
  /** The signal cancels acquisition; a successful lease has an explicit release owner. */
  retain(source: string, signal?: AbortSignal): Promise<StoryResourceLease>;
  /** The host chooses a URI accepted by its renderer and owns its release hook. */
  resolveRenderable(
    source: string,
    signal?: AbortSignal,
  ): Promise<{ readonly url: string; readonly release: () => void }>;
}
