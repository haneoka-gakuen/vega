import {
  VegaEngine,
  type VegaEngineOptions,
  type VegaPlayerHandle,
  type VegaPlayerOptions,
} from "../../engine/VegaEngine";
import type { AdvPlayer } from "../../core/AdvPlayer";
import { createVegaWebPlayerHost } from "./playerHost";

export interface VegaWebPlayerOptions extends Omit<VegaPlayerOptions, "surface"> {
  readonly mount: HTMLElement;
}

export interface VegaWebPlayerHandle extends Omit<VegaPlayerHandle, "player" | "root" | "slots"> {
  readonly player: AdvPlayer;
  readonly root: HTMLElement;
  readonly slots: ReadonlyMap<string, HTMLElement>;
}

/** Browser composition selects its UI, media, persistence and fallback renderer. */
export class VegaWebEngine extends VegaEngine {
  constructor(options: VegaEngineOptions = {}) {
    super({ ...options, playerHost: options.playerHost ?? createVegaWebPlayerHost() });
  }

  override createPlayer(options: VegaWebPlayerOptions): Promise<VegaWebPlayerHandle>;
  override createPlayer(options: VegaPlayerOptions): Promise<VegaWebPlayerHandle>;
  override createPlayer(options: VegaWebPlayerOptions | VegaPlayerOptions): Promise<VegaWebPlayerHandle> {
    const surface = "mount" in options ? options.mount : options.surface;
    return super.createPlayer({ ...options, surface }) as Promise<VegaWebPlayerHandle>;
  }
}

export const createVegaWeb = (options?: VegaEngineOptions): VegaWebEngine => new VegaWebEngine(options);
