import type {
  AdvBackgroundEntry,
  AdvCharacterModelEntry,
  AdvFrameEntry,
  AdvStillEntry,
  AdvPlayerState,
} from "../../types/AdvRuntime";
import type { StoryCameraState, StoryPoint3 } from "../StorySceneBackend";

export const STORY_SCENE_SEEK_SNAPSHOT_VERSION = 1 as const;

export interface AdvSeekCharacterSnapshot {
  readonly target: string;
  readonly identity: string;
  readonly entry: AdvCharacterModelEntry;
  readonly positionType: number;
  readonly alpha: number;
  readonly brightness: number;
  readonly paused: boolean;
  readonly worldPosition: StoryPoint3 | null;
  readonly offset: StoryPoint3;
  /** Portable presentation values used by static and plugin renderers. */
  readonly angle?: number;
  readonly bodyAngle?: number;
  readonly lookX?: number;
  readonly lookY?: number;
  readonly lookEnabled?: boolean;
  readonly lookTargetName?: string;
}

/**
 * Renderer-neutral checkpoint. Backends may return null when transient media
 * prevents a deterministic snapshot.
 */
export interface AdvStorySceneSeekSnapshot {
  readonly version: typeof STORY_SCENE_SEEK_SNAPSHOT_VERSION;
  readonly pluginState?: AdvPlayerState["pluginState"];
  readonly videoLayout?: AdvPlayerState["video"]["layout"];
  readonly background: AdvBackgroundEntry | null;
  readonly still: AdvStillEntry | null;
  readonly frame: AdvFrameEntry | null;
  readonly frameName: string;
  readonly stage: unknown;
  readonly cameraState: StoryCameraState;
  readonly characters: readonly AdvSeekCharacterSnapshot[];
  /**
   * Optional JSON-compatible backend state. A renderer must ignore payloads
   * with an unknown `kind` and may omit this field entirely.
   */
  readonly rendererState?: unknown;
}

export interface SeekSnapshotSafety {
  readonly safe: boolean;
  readonly reason?: string;
}
