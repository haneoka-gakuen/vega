import type { StoryRendererExtensionContext } from "./StoryRendererExtensions";

export interface StoryScreenSpriteImage {
  readonly source: object;
  readonly width: number;
  readonly height: number;
}
/** Instance stride: x, y, rotation, scaleX, scaleY, alpha, u0, v0, u1, v1. */
export interface StoryScreenSpriteBatch {
  readonly id: string;
  readonly layer: "background" | "foreground";
  readonly image: StoryScreenSpriteImage;
  readonly width: number;
  readonly height: number;
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  readonly transform: readonly [number, number, number, number, number, number];
  readonly instances: Float32Array;
  readonly tint: number;
  readonly revision: number;
}
export interface StoryScreenSpriteEffect {
  readonly kind: "screenSprites";
  readonly batches: readonly StoryScreenSpriteBatch[];
  update(deltaSeconds: number): void;
  snapshot(): unknown;
  restore(value: unknown): void;
  dispose(): void;
}
export interface StoryScreenEffectDefinition {
  readonly effectType: string;
  readonly [key: string]: unknown;
}
export interface StoryScreenEffectSnapshot {
  readonly key: string;
  readonly definition: StoryScreenEffectDefinition;
  readonly state: unknown;
}
export function isStoryScreenSpriteEffect(value: unknown): value is StoryScreenSpriteEffect {
  if (!value || typeof value !== "object") return false;
  const effect = value as Partial<StoryScreenSpriteEffect>;
  return (
    effect.kind === "screenSprites" &&
    Array.isArray(effect.batches) &&
    typeof effect.update === "function" &&
    typeof effect.snapshot === "function" &&
    typeof effect.restore === "function" &&
    typeof effect.dispose === "function"
  );
}
export type StoryScreenEffectContext = StoryRendererExtensionContext;

interface ActiveScreenEffect {
  readonly key: string;
  readonly order: number;
  readonly definition: StoryScreenEffectDefinition;
  readonly effect: StoryScreenSpriteEffect;
  readonly controller: AbortController;
  readonly detach: () => void;
}
export class StoryScreenEffects {
  private readonly active = new Map<string, ActiveScreenEffect>();
  private readonly pending = new Map<string, { order: number; controller: AbortController; detach: () => void }>();
  private sequence = 0;
  private disposed = false;
  private ordered: readonly ActiveScreenEffect[] = [];
  private layers: readonly StoryScreenSpriteBatch[] = [];
  constructor(
    private readonly signal: AbortSignal,
    private readonly create: (
      definition: StoryScreenEffectDefinition,
      signal: AbortSignal,
    ) => Promise<StoryScreenSpriteEffect>,
    private readonly changed: () => void = () => {},
  ) {}
  get batches(): readonly StoryScreenSpriteBatch[] {
    return this.layers;
  }
  get ready(): boolean {
    return this.pending.size === 0;
  }
  get size(): number {
    return this.active.size;
  }
  get keys(): readonly string[] {
    return [...this.active, ...this.pending].sort((a, b) => a[1].order - b[1].order).map(([key]) => key);
  }
  async set(
    key: string,
    definition: StoryScreenEffectDefinition,
    signal?: AbortSignal,
  ): Promise<StoryScreenSpriteEffect> {
    if (this.disposed) throw new Error("Screen effects have been disposed");
    this.clear(key);
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    const order = this.sequence++,
      controller = new AbortController();
    const abort = () => controller.abort();
    this.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    const detach = () => {
      this.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    };
    const pending = { order, controller, detach };
    this.pending.set(key, pending);
    let effect: StoryScreenSpriteEffect | undefined;
    try {
      effect = await this.create(definition, controller.signal);
      controller.signal.throwIfAborted();
      signal?.removeEventListener("abort", abort);
      this.pending.delete(key);
      this.active.set(key, { key, order, definition, effect, controller, detach });
      this.refresh();
      return effect;
    } catch (error) {
      if (this.pending.get(key) === pending) this.pending.delete(key);
      if (this.active.get(key)?.effect === effect) this.active.delete(key);
      detach();
      controller.abort();
      try {
        effect?.dispose();
      } finally {
        this.refresh();
      }
      throw error;
    }
  }
  clear(key?: string): void {
    const keys = key === undefined ? new Set([...this.active.keys(), ...this.pending.keys()]) : new Set([key]);
    const errors: unknown[] = [];
    for (const id of keys) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.detach();
        pending.controller.abort();
      }
      const active = this.active.get(id);
      if (active) {
        this.active.delete(id);
        active.detach();
        active.controller.abort();
        try {
          active.effect.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    this.refresh();
    if (errors.length) throw new AggregateError(errors, "Screen effect disposal failed");
  }
  update(deltaSeconds: number): void {
    for (const entry of this.ordered) entry.effect.update(deltaSeconds);
  }
  snapshot(): readonly StoryScreenEffectSnapshot[] {
    return this.ordered.map((entry) => ({
      key: entry.key,
      definition: entry.definition,
      state: entry.effect.snapshot(),
    }));
  }
  async restore(snapshots: readonly StoryScreenEffectSnapshot[], signal?: AbortSignal): Promise<void> {
    this.clear();
    const owned = new Map<string, AbortController>();
    const results = await Promise.allSettled(
      snapshots.map((entry) => {
        const created = this.set(entry.key, entry.definition, signal);
        const pending = this.pending.get(entry.key);
        if (pending) owned.set(entry.key, pending.controller);
        return created.then((effect) => {
          if (this.active.get(entry.key)?.effect === effect) effect.restore(entry.state);
        });
      }),
    );
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) {
      for (const [key, controller] of owned) {
        if ((this.active.get(key) ?? this.pending.get(key))?.controller === controller) this.clear(key);
      }
      throw new AggregateError(errors, "Screen effects could not be restored");
    }
    this.refresh();
  }
  dispose(): void {
    this.disposed = true;
    this.clear();
  }
  private refresh(): void {
    this.ordered = [...this.active.values()].sort((a, b) => a.order - b.order);
    this.layers = this.ordered.flatMap((entry) => entry.effect.batches);
    this.changed();
  }
}
