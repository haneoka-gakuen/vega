import type { VegaBacklogEntry, VegaNarrativeSettings, VegaSaveData, VegaUnlockKind } from "@haneoka/vega-protocol";
import { defineVegaService, type VegaDisposable } from "../engine/plugins";
import type { VegaUiSlotContext } from "../engine/plugins";

export type VegaShellScreen =
  "title" | "game" | "menu" | "save" | "load" | "settings" | "backlog" | "gallery" | "flowchart";

export interface VegaShellFlowNode {
  readonly id: string;
  readonly label: string;
  readonly sceneId: string;
  readonly visited: boolean;
  readonly current: boolean;
  readonly chapter?: string;
  readonly thumbnail?: string;
  readonly description?: string;
}

export interface VegaShellFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: "jump" | "call" | "branch";
  readonly condition?: string;
}

export interface VegaShellGalleryItem {
  readonly id: string;
  readonly kind: VegaUnlockKind;
  readonly title: string;
  readonly thumbnail?: string;
  readonly source?: string;
  readonly unlocked: boolean;
}

export interface VegaShellSnapshot {
  readonly projectId: string;
  readonly title: string;
  readonly screen: VegaShellScreen;
  /**
   * Stable root for the currently visible shell page. Additive and optional so
   * externally supplied v1 controllers remain source-compatible.
   */
  readonly navigationOrigin?: "title" | "game";
  readonly canContinue: boolean;
  readonly paused: boolean;
  readonly autoPlay: boolean;
  readonly fastForward: boolean;
  readonly settings: VegaNarrativeSettings;
  readonly saves: readonly VegaSaveData[];
  readonly backlog: readonly VegaBacklogEntry[];
  readonly gallery: readonly VegaShellGalleryItem[];
  readonly flow: readonly VegaShellFlowNode[];
  readonly flowEdges: readonly VegaShellFlowEdge[];
}

export interface VegaShellController {
  snapshot(): VegaShellSnapshot;
  subscribe(listener: (snapshot: VegaShellSnapshot) => void): VegaDisposable;
  start(): Promise<void>;
  continue(): Promise<void>;
  /**
   * Moves shell presentation into the game without changing playback.
   * Editor/debug runtimes use this before they execute through their own
   * scheduler so the title or menu cannot cover the inspected stage.
   */
  enterGame(): void;
  resume(): void;
  pause(): void;
  open(screen: Exclude<VegaShellScreen, "game">): Promise<void> | void;
  close(): void;
  save(slot: string, label?: string): Promise<void>;
  load(slot: string): Promise<void>;
  deleteSave(slot: string): Promise<void>;
  quickSave(): Promise<void>;
  quickLoad(): Promise<void>;
  setSetting<K extends keyof VegaNarrativeSettings>(key: K, value: VegaNarrativeSettings[K]): void;
  jumpToBacklog(entryId: string): Promise<void>;
  jumpToFlowNode(nodeId: string): Promise<void>;
  toggleAuto(): void;
  toggleFastForward(): void;
  /** Returns to this game's title without asking a desktop host to exit. */
  returnToTitle?(): Promise<void> | void;
  exit(): Promise<void>;
}

/** Per-player shell controller supplied to `ui-slot` contributions. */
export const VEGA_SHELL_CONTROLLER = defineVegaService<VegaShellController>("vega.shell-controller.v1");

export interface VegaShellTextRenderer {
  set(element: HTMLElement, text: string): void;
  releaseWithin(root: Node): void;
  dispose(): void;
}
export const VEGA_SHELL_TYPOGRAPHY = defineVegaService<{
  create(context: VegaUiSlotContext): VegaShellTextRenderer;
}>("vega.shell-typography.v1");
