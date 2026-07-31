import type { VegaInputEvent } from "./plugins";

export interface VegaEventMap {
  "engine:ready": { readonly engineId: string };
  "engine:dispose": { readonly engineId: string };
  input: VegaInputEvent;
  "player:create": { readonly playerId: string };
  "player:dispose": { readonly playerId: string };
  "shell:exit-request": { readonly engineId: string; readonly playerId: string };
  "plugin:installed": { readonly pluginId: string };
  "plugin:removed": { readonly pluginId: string };
  "diagnostic": VegaDiagnosticEvent;
}

export interface VegaDiagnosticEvent {
  readonly level: "debug" | "info" | "warning" | "error";
  readonly code: string;
  readonly message: string;
  readonly source?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type VegaEventHandler<T> = (event: T) => void | Promise<void>;

export class VegaEventBus<Events extends object = VegaEventMap> {
  private readonly handlers = new Map<keyof Events, Set<VegaEventHandler<never>>>();

  on<K extends keyof Events>(type: K, handler: VegaEventHandler<Events[K]>): () => void {
    const handlers = this.handlers.get(type) ?? new Set();
    handlers.add(handler as VegaEventHandler<never>);
    this.handlers.set(type, handlers);
    return () => {
      handlers.delete(handler as VegaEventHandler<never>);
      if (!handlers.size) this.handlers.delete(type);
    };
  }

  async emit<K extends keyof Events>(type: K, event: Events[K]): Promise<void> {
    const handlers = [...(this.handlers.get(type) ?? [])];
    const results = await Promise.allSettled(handlers.map((handler) => handler(event as never)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, `Vega event handlers failed for ${String(type)}`);
  }

  clear(): void {
    this.handlers.clear();
  }
}
