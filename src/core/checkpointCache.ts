import type { AdvStory } from "../types/AdvRuntime";

export const ADV_SEEK_CHECKPOINT_VERSION = 1 as const;

/** Reuse unchanged immutable snapshot branches without modifying either input. */
export function shareSeekSnapshot<T>(previous: T | undefined, current: T): T {
  const visited = new WeakSet<object>();
  const share = (before: unknown, after: unknown): unknown => {
    if (Object.is(before, after)) return before;
    if (!before || !after || typeof before !== "object" || typeof after !== "object") return after;
    const array = Array.isArray(after);
    if (array !== Array.isArray(before)) return after;
    const prototype = Object.getPrototypeOf(after);
    if (!array && prototype !== Object.prototype && prototype !== null) return after;
    if (Object.getPrototypeOf(before) !== prototype || visited.has(after)) return after;
    visited.add(after);
    const keys = Object.keys(after);
    const beforeKeys = Object.keys(before);
    let equal =
      keys.length === beforeKeys.length && (!array || (before as unknown[]).length === (after as unknown[]).length);
    let replacements: Array<readonly [string, unknown]> | undefined;
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of keys) {
      const value = share(left[key], right[key]);
      if (!Object.hasOwn(left, key) || !Object.is(value, left[key])) equal = false;
      if (!Object.is(value, right[key])) {
        (replacements ??= []).push([key, value]);
      }
    }
    if (equal) return before;
    if (!replacements) return after;
    const copy = (
      array
        ? (after as unknown[]).slice()
        : prototype === null
          ? Object.assign(Object.create(null), right)
          : { ...right }
    ) as Record<string, unknown>;
    for (const [key, value] of replacements) {
      Object.defineProperty(copy, key, { value, enumerable: true, configurable: true, writable: true });
    }
    return copy;
  };
  return share(previous, current) as T;
}

export interface AdvSeekCheckpoint<
  TScene = unknown,
  TSession = unknown,
  TLoader = unknown,
  TSound = unknown,
  TState = unknown,
> {
  readonly version: typeof ADV_SEEK_CHECKPOINT_VERSION;
  /** Index of the next command. The snapshot is taken after index - 1 settled. */
  readonly index: number;
  readonly commandCount: number;
  readonly scene: TScene;
  readonly session: TSession;
  readonly loader: TLoader;
  readonly sound: TSound;
  readonly state: TState;
}

export interface AdvSeekCheckpointIndex {
  readonly signature: string;
  readonly checkpoints: Map<number, AdvSeekCheckpoint>;
  /** Command boundaries in authored traversal order for this decision path. */
  readonly boundaries: number[];
  complete: boolean;
  blockedAt: number | null;
  blockedReason: string;
}

const sharedStoryCheckpointIndexes = new WeakMap<object, Map<string, AdvSeekCheckpointIndex>>();

export const releaseCheckpointIndexes = (owner: object): void => {
  sharedStoryCheckpointIndexes.delete(owner);
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
};

/** Stable identity for one authored choice path. */
export function seekDecisionSignature(decisions: ReadonlyMap<number, unknown>): string {
  return JSON.stringify(
    [...decisions.entries()]
      .sort(([left], [right]) => left - right)
      .map(([key, value]) => [key, stableJsonValue(value)]),
  );
}

export function sharedCheckpointIndexFor(
  story: AdvStory,
  signature: string,
  owner: object = story,
): AdvSeekCheckpointIndex {
  let indexes = sharedStoryCheckpointIndexes.get(owner);
  if (!indexes) {
    indexes = new Map();
    sharedStoryCheckpointIndexes.set(owner, indexes);
  }
  let index = indexes.get(signature);
  if (!index) {
    index = {
      signature,
      checkpoints: new Map(),
      boundaries: [],
      complete: false,
      blockedAt: null,
      blockedReason: "",
    };
    indexes.set(signature, index);
  }
  return index;
}
